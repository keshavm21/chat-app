import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pool from '../db/connection.js';
import { MAX_ID } from '../lib/ids.js';
import { USER_SEARCH_LIMIT } from '../lib/limits.js';
import { api, signUp, startServer, type TestServer } from './helpers.js';

// Finding someone and opening a DM with them (docs/phase-3-implementation-plan.md §5).

let server: TestServer;

beforeAll(async () => {
  server = await startServer();
});

afterAll(async () => {
  await server.close();
});

type TestUser = Awaited<ReturnType<typeof signUp>>;

function openDm(from: TestUser, userId: unknown) {
  return api(server).post('/api/dms').set('Cookie', from.cookie).send({ userId });
}

async function dmRows() {
  const conversations = await pool.query(`SELECT id FROM conversations WHERE type = 'dm'`);
  const pairs = await pool.query('SELECT conversation_id, user_a_id, user_b_id FROM direct_conversations');
  const members = await pool.query(
    `SELECT m.user_id, m.role FROM conversation_members m JOIN conversations c ON c.id = m.conversation_id
     WHERE c.type = 'dm' ORDER BY m.user_id`,
  );
  return { conversations: conversations.rows, pairs: pairs.rows, members: members.rows };
}

describe('POST /api/dms', () => {
  it('creates the DM with another user: 201, both are members, and it is named after the other user', async () => {
    const alice = await signUp(server);
    const bob = await signUp(server);

    const res = await openDm(alice, bob.user.id);

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      conversation: {
        id: expect.any(Number),
        type: 'dm',
        visibility: null,
        name: bob.username,
        topic: null,
        role: 'member',
        lastSeq: 0,
        lastReadSeq: 0,
        unreadCount: 0,
        lastMessageAt: null,
        lastActivityAt: expect.any(String),
      },
    });
    expect(await dmRows()).toEqual({
      conversations: [{ id: res.body.conversation.id }],
      pairs: [{ conversation_id: res.body.conversation.id, user_a_id: alice.user.id, user_b_id: bob.user.id }],
      members: [
        { user_id: alice.user.id, role: 'member' },
        { user_id: bob.user.id, role: 'member' },
      ],
    });
  });

  it('returns the existing DM with 200, from either side', async () => {
    const alice = await signUp(server);
    const bob = await signUp(server);
    const created = await openDm(alice, bob.user.id).expect(201);

    const again = await openDm(alice, bob.user.id);
    const reverse = await openDm(bob, alice.user.id);

    expect(again.status).toBe(200);
    expect(again.body).toEqual(created.body);
    expect(reverse.status).toBe(200);
    expect(reverse.body.conversation).toMatchObject({ id: created.body.conversation.id, name: alice.username });
    expect((await dmRows()).conversations).toHaveLength(1);
  });

  it('creates one DM when many requests for the same pair race, from both sides', async () => {
    const alice = await signUp(server);
    const bob = await signUp(server);

    // All in flight at once: none of them finds a DM, so they all try to create it.
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? openDm(alice, bob.user.id) : openDm(bob, alice.user.id))),
    );

    expect(responses.map((res) => res.status).sort()).toEqual([200, 200, 200, 200, 200, 200, 200, 200, 200, 201]);
    const ids = new Set(responses.map((res) => res.body.conversation.id));
    expect(ids.size).toBe(1);
    // The losers' conversation rows were rolled back: there is no DM without its pair.
    const rows = await dmRows();
    expect(rows.conversations).toEqual([{ id: [...ids][0] }]);
    expect(rows.pairs).toHaveLength(1);
    expect(rows.members).toHaveLength(2);
  });

  it('answers 400 for a DM with yourself', async () => {
    const alice = await signUp(server);

    const res = await openDm(alice, alice.user.id);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'You cannot start a conversation with yourself.',
        details: [{ field: 'userId', message: 'You cannot start a conversation with yourself.' }],
      },
    });
  });

  it.each([[undefined], ['2'], [0], [-1], [1.5], [MAX_ID + 1], [null]])('answers 400 for userId %j', async (userId) => {
    const alice = await signUp(server);

    const res = await openDm(alice, userId);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('answers 404 for a user that does not exist', async () => {
    const alice = await signUp(server);

    const res = await openDm(alice, MAX_ID);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: 'User not found.' } });
    expect((await dmRows()).conversations).toEqual([]);
  });
});

describe('GET /api/users', () => {
  async function search(user: TestUser, q?: string) {
    const req = api(server).get('/api/users').set('Cookie', user.cookie);
    const res = await (q === undefined ? req : req.query({ q })).expect(200);
    return res.body.users as { id: number; username: string }[];
  }

  it('finds other users by username prefix, ignoring case and spaces, by username', async () => {
    const alex = await signUp(server, { username: 'alex' });
    const anna = await signUp(server, { username: 'anna' });
    const amy = await signUp(server, { username: 'amy' });
    await signUp(server, { username: 'bob' });

    expect(await search(alex, 'a')).toEqual([
      { id: amy.user.id, username: 'amy' },
      { id: anna.user.id, username: 'anna' },
    ]);
    expect(await search(alex, ' AM ')).toEqual([{ id: amy.user.id, username: 'amy' }]);
    expect(await search(alex, 'z')).toEqual([]);
  });

  it(`returns at most ${USER_SEARCH_LIMIT} users, also without q, never including me`, async () => {
    const me = await signUp(server, { username: 'aaa_me' });
    for (let i = 0; i < USER_SEARCH_LIMIT + 2; i += 1) await signUp(server, { username: `member${String(i).padStart(2, '0')}` });

    const all = await search(me);

    expect(all).toHaveLength(USER_SEARCH_LIMIT);
    expect(all.map((user) => user.username)).not.toContain('aaa_me');
    expect(await search(me, 'aaa')).toEqual([]);
  });

  it('takes q literally: an underscore is not a wildcard', async () => {
    const alex = await signUp(server, { username: 'alex' });
    const underscored = await signUp(server, { username: 'a_b' });
    await signUp(server, { username: 'axb' });

    expect(await search(alex, 'a_')).toEqual([{ id: underscored.user.id, username: 'a_b' }]);
  });

  it.each(['q=a&q=b', 'q=%25', 'q=a%00', `q=${'x'.repeat(101)}`])('answers 400 for %s', async (query) => {
    const alex = await signUp(server);

    const res = await api(server).get(`/api/users?${query}`).set('Cookie', alex.cookie);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});
