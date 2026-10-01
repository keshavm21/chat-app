import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pool from '../db/connection.js';
import { MAX_ID } from '../lib/ids.js';
import { api, createChannel, generalId, postMessages, signUp, startServer, type TestServer } from './helpers.js';

// My conversations, joining, leaving, read positions and private channels' members
// (docs/phase-3-implementation-plan.md §5). Reading needs membership; everyone else gets 404.

let server: TestServer;

beforeAll(async () => {
  server = await startServer();
});

afterAll(async () => {
  await server.close();
});

type TestUser = Awaited<ReturnType<typeof signUp>>;

const NOT_FOUND = { error: { code: 'NOT_FOUND', message: 'Conversation not found.' } };

async function conversationsOf(user: TestUser) {
  const res = await api(server).get('/api/conversations').set('Cookie', user.cookie).expect(200);
  return res.body.conversations as Record<string, unknown>[];
}

function join(user: TestUser, conversationId: number | string) {
  return api(server).post(`/api/conversations/${conversationId}/join`).set('Cookie', user.cookie).send({});
}

function leave(user: TestUser, conversationId: number | string) {
  return api(server).post(`/api/conversations/${conversationId}/leave`).set('Cookie', user.cookie).send({});
}

function markRead(user: TestUser, conversationId: number | string, body: unknown) {
  return api(server).put(`/api/conversations/${conversationId}/read`).set('Cookie', user.cookie).send(body as object);
}

function addMember(user: TestUser, conversationId: number, body: unknown) {
  return api(server).post(`/api/conversations/${conversationId}/members`).set('Cookie', user.cookie).send(body as object);
}

async function openDm(from: TestUser, to: TestUser) {
  const res = await api(server).post('/api/dms').set('Cookie', from.cookie).send({ userId: to.user.id }).expect(201);
  return res.body.conversation as { id: number };
}

async function isMember(conversationId: number, userId: number) {
  const { rows } = await pool.query('SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [
    conversationId,
    userId,
  ]);
  return rows.length === 1;
}

describe('every conversation route', () => {
  it.each([
    ['get', '/api/conversations'],
    ['get', '/api/conversations/1/messages'],
    ['put', '/api/conversations/1/read'],
    ['post', '/api/conversations/1/join'],
    ['post', '/api/conversations/1/leave'],
    ['post', '/api/conversations/1/members'],
    ['get', '/api/channels'],
    ['post', '/api/channels'],
    ['post', '/api/dms'],
    ['get', '/api/users'],
  ] as const)('answers %s %s with 401 without a valid session', async (method, url) => {
    for (const cookie of [undefined, 'relay_session=unknown-token']) {
      const req = api(server)[method](url);
      if (cookie) req.set('Cookie', cookie);
      const res = await (method === 'get' ? req : req.send({}));

      expect(res.status).toBe(401);
      expect(res.body).toEqual({
        error: { code: 'UNAUTHENTICATED', message: 'Your session has expired. Please log in again.' },
      });
    }
  });
});

describe('GET /api/conversations', () => {
  it('lists #general after signup, with nothing unread', async () => {
    const alice = await signUp(server);

    expect(await conversationsOf(alice)).toEqual([
      {
        id: await generalId(),
        type: 'channel',
        visibility: 'public',
        name: 'general',
        topic: null,
        role: 'member',
        lastSeq: 0,
        lastReadSeq: 0,
        unreadCount: 0,
        lastMessageAt: null,
        lastActivityAt: expect.any(String),
      },
    ]);
  });

  it("counts unread messages as lastSeq − lastReadSeq; a later member's count starts at 0", async () => {
    const alice = await signUp(server);
    const bob = await signUp(server);
    await postMessages(await generalId(), bob.user.id, 3);

    expect(await conversationsOf(alice)).toEqual([
      expect.objectContaining({ lastSeq: 3, lastReadSeq: 0, unreadCount: 3, lastMessageAt: expect.any(String) }),
    ]);
    const carol = await signUp(server);
    expect(await conversationsOf(carol)).toEqual([expect.objectContaining({ lastSeq: 3, lastReadSeq: 3, unreadCount: 0 })]);
  });

  it('names a DM after the other user, for each of them', async () => {
    const alice = await signUp(server);
    const bob = await signUp(server);
    const dm = await openDm(alice, bob);

    expect((await conversationsOf(alice)).find((c) => c.id === dm.id)).toMatchObject({ type: 'dm', name: bob.username });
    expect((await conversationsOf(bob)).find((c) => c.id === dm.id)).toMatchObject({ type: 'dm', name: alice.username });
  });

  it('puts the most recently active first, by lastActivityAt: the latest message, or when I joined', async () => {
    const alice = await signUp(server);
    const older = await createChannel(server, alice, { name: 'older' });
    const newer = await createChannel(server, alice, { name: 'newer' });
    const general = await generalId();

    const before = await conversationsOf(alice);
    expect(before.map((c) => c.id)).toEqual([newer.id, older.id, general]);
    const activity = before.map((c) => Date.parse(c.lastActivityAt as string));
    expect(activity).toEqual([...activity].sort((a, b) => b - a));

    await postMessages(older.id, alice.user.id, 1);
    const after = await conversationsOf(alice);
    expect(after.map((c) => c.id)).toEqual([older.id, newer.id, general]);
    // A message makes its conversation's last activity the message's time.
    expect(after[0].lastActivityAt).toBe(after[0].lastMessageAt);
  });

  it("does not list conversations I am not in", async () => {
    const alice = await signUp(server);
    const bob = await signUp(server);
    const carol = await signUp(server);
    await createChannel(server, alice, { name: 'public-one' });
    await createChannel(server, alice, { name: 'private-one', visibility: 'private' });
    await openDm(alice, bob);

    expect((await conversationsOf(carol)).map((c) => c.name)).toEqual(['general']);
  });
});

describe('POST /api/conversations/:id/join', () => {
  it('joins a public channel with nothing unread, and answers with its summary', async () => {
    const alice = await signUp(server);
    const bob = await signUp(server);
    const news = await createChannel(server, alice, { name: 'news', topic: 'Headlines' });
    await postMessages(news.id, alice.user.id, 2);

    const res = await join(bob, news.id);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      conversation: {
        id: news.id,
        type: 'channel',
        visibility: 'public',
        name: 'news',
        topic: 'Headlines',
        role: 'member',
        lastSeq: 2,
        lastReadSeq: 2,
        unreadCount: 0,
        lastMessageAt: expect.any(String),
        lastActivityAt: expect.any(String),
      },
    });
    expect(await isMember(news.id, bob.user.id)).toBe(true);
  });

  it('changes nothing for a conversation I am already in: my read position stays', async () => {
    const alice = await signUp(server);
    const bob = await signUp(server);
    const news = await createChannel(server, alice, { name: 'news' });
    await join(bob, news.id).expect(200);
    await postMessages(news.id, alice.user.id, 2);

    const again = await join(bob, news.id);
    const owner = await join(alice, news.id);

    expect(again.status).toBe(200);
    expect(again.body.conversation).toMatchObject({ lastReadSeq: 0, unreadCount: 2, role: 'member' });
    expect(owner.body.conversation).toMatchObject({ role: 'owner' });
  });

  it('answers 200 to every one of several concurrent joins (a double click, two tabs)', async () => {
    const alice = await signUp(server);
    const bob = await signUp(server);
    const news = await createChannel(server, alice, { name: 'news' });

    const responses = await Promise.all(Array.from({ length: 5 }, () => join(bob, news.id)));

    expect(responses.map((res) => res.status)).toEqual([200, 200, 200, 200, 200]);
    expect(responses.map((res) => res.body.conversation.id)).toEqual([news.id, news.id, news.id, news.id, news.id]);
    expect(await isMember(news.id, bob.user.id)).toBe(true);
  });

  it('answers 404 for a private channel, a DM, no such conversation or a malformed id, and joins nothing', async () => {
    const alice = await signUp(server);
    const bob = await signUp(server);
    const carol = await signUp(server);
    const secret = await createChannel(server, alice, { name: 'secret', visibility: 'private' });
    const dm = await openDm(alice, bob);

    for (const id of [secret.id, dm.id, MAX_ID, 'abc', '0', '01', '1.5', '-1', String(MAX_ID + 1)]) {
      const res = await join(carol, id);
      expect(res.status, String(id)).toBe(404);
      expect(res.body).toEqual(NOT_FOUND);
    }
    expect(await isMember(secret.id, carol.user.id)).toBe(false);
    expect(await isMember(dm.id, carol.user.id)).toBe(false);
  });
});

describe('POST /api/conversations/:id/leave', () => {
  it('leaves a public channel: 204, and it is gone from my conversations', async () => {
    const alice = await signUp(server);
    const bob = await signUp(server);
    const news = await createChannel(server, alice, { name: 'news' });
    await join(bob, news.id).expect(200);

    const res = await leave(bob, news.id);

    expect(res.status).toBe(204);
    expect(await isMember(news.id, bob.user.id)).toBe(false);
    expect((await conversationsOf(bob)).map((c) => c.name)).toEqual(['general']);
  });

  it('lets the owner leave a public channel, which stays for everyone else', async () => {
    const alice = await signUp(server);
    const news = await createChannel(server, alice, { name: 'news' });

    await leave(alice, news.id).expect(204);

    const { rows } = await pool.query('SELECT name FROM conversations WHERE id = $1', [news.id]);
    expect(rows).toEqual([{ name: 'news' }]);
  });

  it('answers 403 for #general', async () => {
    const alice = await signUp(server);

    const res = await leave(alice, await generalId());

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: { code: 'FORBIDDEN', message: 'You cannot leave #general.' } });
    expect(await isMember(await generalId(), alice.user.id)).toBe(true);
  });

  it('answers 403 for a DM, for either of its users', async () => {
    const alice = await signUp(server);
    const bob = await signUp(server);
    const dm = await openDm(alice, bob);

    for (const user of [alice, bob]) {
      const res = await leave(user, dm.id);
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: { code: 'FORBIDDEN', message: 'Direct messages cannot be left.' } });
      expect(await isMember(dm.id, user.user.id)).toBe(true);
    }
  });

  it("lets a private channel's members leave, which ends their access at once, but not its owner", async () => {
    const alice = await signUp(server);
    const bob = await signUp(server);
    const secret = await createChannel(server, alice, { name: 'secret', visibility: 'private' });
    await addMember(alice, secret.id, { username: bob.username }).expect(204);

    const owner = await leave(alice, secret.id);
    expect(owner.status).toBe(403);
    expect(owner.body).toEqual({ error: { code: 'FORBIDDEN', message: 'The owner cannot leave a private channel.' } });
    expect(await isMember(secret.id, alice.user.id)).toBe(true);

    await leave(bob, secret.id).expect(204);
    expect(await isMember(secret.id, bob.user.id)).toBe(false);
    expect((await conversationsOf(bob)).map((c) => c.id)).not.toContain(secret.id);
    for (const res of [
      await api(server).get(`/api/conversations/${secret.id}/messages`).set('Cookie', bob.cookie),
      await markRead(bob, secret.id, { seq: 0 }),
      await join(bob, secret.id), // and cannot come back in by himself
    ]) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual(NOT_FOUND);
    }
    // The owner can add him again.
    await addMember(alice, secret.id, { username: bob.username }).expect(204);
    expect(await isMember(secret.id, bob.user.id)).toBe(true);
  });

  it('tells #general from a private channel of the same name', async () => {
    const alice = await signUp(server);
    const bob = await signUp(server);
    const fake = await createChannel(server, alice, { name: 'general', visibility: 'private' });
    await addMember(alice, fake.id, { username: bob.username }).expect(204);

    await leave(bob, fake.id).expect(204);
    expect((await leave(bob, await generalId())).status).toBe(403);
  });

  it('answers 404 for a conversation I am not in', async () => {
    const alice = await signUp(server);
    const bob = await signUp(server);
    const news = await createChannel(server, alice, { name: 'news' });

    for (const id of [news.id, MAX_ID, 'abc', '01', String(MAX_ID + 1)]) {
      const res = await leave(bob, id);
      expect(res.status).toBe(404);
      expect(res.body).toEqual(NOT_FOUND);
    }
  });
});

describe('PUT /api/conversations/:id/read', () => {
  it('moves my read position forward, never back', async () => {
    const alice = await signUp(server);
    const bob = await signUp(server);
    const general = await generalId();
    await postMessages(general, bob.user.id, 5);

    await markRead(alice, general, { seq: 3 }).expect(204);
    expect(await conversationsOf(alice)).toEqual([expect.objectContaining({ lastReadSeq: 3, unreadCount: 2 })]);

    await markRead(alice, general, { seq: 1 }).expect(204);
    expect(await conversationsOf(alice)).toEqual([expect.objectContaining({ lastReadSeq: 3, unreadCount: 2 })]);

    await markRead(alice, general, { seq: 5 }).expect(204);
    expect(await conversationsOf(alice)).toEqual([expect.objectContaining({ lastReadSeq: 5, unreadCount: 0 })]);
  });

  it('never moves past the last message, so the unread count cannot go negative', async () => {
    const alice = await signUp(server);
    const general = await generalId();
    await postMessages(general, alice.user.id, 2);

    await markRead(alice, general, { seq: MAX_ID }).expect(204);

    expect(await conversationsOf(alice)).toEqual([expect.objectContaining({ lastSeq: 2, lastReadSeq: 2, unreadCount: 0 })]);
  });

  it('changes only my own read position', async () => {
    const alice = await signUp(server);
    const bob = await signUp(server);
    const general = await generalId();
    await postMessages(general, alice.user.id, 2);

    await markRead(alice, general, { seq: 2 }).expect(204);

    expect(await conversationsOf(bob)).toEqual([expect.objectContaining({ lastReadSeq: 0, unreadCount: 2 })]);
  });

  it.each([[{}], [{ seq: -1 }], [{ seq: 1.5 }], [{ seq: '3' }], [{ seq: null }], [{ seq: MAX_ID + 1 }]])(
    'answers 400 for %j',
    async (body) => {
      const alice = await signUp(server);

      const res = await markRead(alice, await generalId(), body);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    },
  );

  it('answers 404 for a conversation I am not in', async () => {
    const alice = await signUp(server);
    const bob = await signUp(server);
    const secret = await createChannel(server, alice, { name: 'secret', visibility: 'private' });

    const res = await markRead(bob, secret.id, { seq: 0 });

    expect(res.status).toBe(404);
    expect(res.body).toEqual(NOT_FOUND);
  });
});

describe('private channels', () => {
  it('are invisible to non-members: not listed, and every conversation route answers 404', async () => {
    const alice = await signUp(server);
    const bob = await signUp(server);
    const secret = await createChannel(server, alice, { name: 'secret', visibility: 'private' });
    await postMessages(secret.id, alice.user.id, 1);

    const listed = await api(server).get('/api/channels').set('Cookie', bob.cookie).expect(200);
    expect(listed.body.channels.map((c: { name: string }) => c.name)).toEqual(['general']);
    for (const res of [
      await api(server).get(`/api/conversations/${secret.id}/messages`).set('Cookie', bob.cookie),
      await markRead(bob, secret.id, { seq: 1 }),
      await join(bob, secret.id),
      await leave(bob, secret.id),
      await addMember(bob, secret.id, { username: bob.username }),
    ]) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual(NOT_FOUND);
    }
    expect(await isMember(secret.id, bob.user.id)).toBe(false);
  });

  it('let their owner add members by username; adding someone again changes nothing', async () => {
    const alice = await signUp(server);
    const bob = await signUp(server);
    const secret = await createChannel(server, alice, { name: 'secret', visibility: 'private' });
    await postMessages(secret.id, alice.user.id, 2);

    await addMember(alice, secret.id, { username: `  ${bob.username.toUpperCase()} ` }).expect(204);
    await addMember(alice, secret.id, { username: bob.username }).expect(204);

    expect((await conversationsOf(bob)).find((c) => c.id === secret.id)).toMatchObject({
      name: 'secret',
      visibility: 'private',
      role: 'member',
      unreadCount: 0,
    });
    const { rows } = await pool.query('SELECT count(*)::int AS count FROM conversation_members WHERE conversation_id = $1', [
      secret.id,
    ]);
    expect(rows[0].count).toBe(2);
  });

  it('let only their owner add members: other members, and anyone in a public channel or DM, get 403', async () => {
    const alice = await signUp(server);
    const bob = await signUp(server);
    const carol = await signUp(server);
    const secret = await createChannel(server, alice, { name: 'secret', visibility: 'private' });
    await addMember(alice, secret.id, { username: bob.username }).expect(204);
    const news = await createChannel(server, alice, { name: 'news' });
    const dm = await openDm(alice, bob);

    for (const [user, id] of [[bob, secret.id], [alice, news.id], [alice, dm.id]] as const) {
      const res = await addMember(user, id, { username: carol.username });
      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        error: { code: 'FORBIDDEN', message: 'Only the owner of a private channel can add members.' },
      });
    }
    expect(await isMember(secret.id, carol.user.id)).toBe(false);
  });

  it('answer 404 for an unknown username and 400 for a missing one', async () => {
    const alice = await signUp(server);
    const secret = await createChannel(server, alice, { name: 'secret', visibility: 'private' });

    const unknown = await addMember(alice, secret.id, { username: 'nobody_here' });
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual({ error: { code: 'NOT_FOUND', message: 'User not found.' } });

    for (const body of [{}, { username: '' }, { username: 42 }, { username: 'has space' }, { username: 'a\u0000b' }]) {
      const res = await addMember(alice, secret.id, body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
  });
});
