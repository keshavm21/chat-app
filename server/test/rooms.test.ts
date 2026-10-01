import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io-client';
import pool from '../db/connection.js';
import { MAX_ID } from '../lib/ids.js';
import { logger } from '../lib/logger.js';
import {
  api,
  collectEvents,
  connectSocket,
  createChannel,
  disconnectAllSockets,
  generalId,
  nextEvent,
  signUp,
  startServer,
  type TestServer,
} from './helpers.js';

// Socket rooms per conversation (docs/phase-3-implementation-plan.md §5): each socket is in
// its user's room and its conversations' rooms, messages and typing go to a conversation's
// room only, and joining, leaving and new DMs move the user's sockets at once.
//
// "Receives nothing" is proven without waiting: a socket receives its events in the order
// the server sent them, so once a later sentinel message has arrived, an event sent before
// it can no longer come.

let server: TestServer;

beforeAll(async () => {
  server = await startServer();
});

afterEach(() => {
  disconnectAllSockets();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await server.close();
});

type TestUser = Awaited<ReturnType<typeof signUp>>;

interface Message {
  id: number;
  conversationId: number;
  seq: number;
  userId: number;
  username: string;
  content: string;
  createdAt: string;
}

/** Sends a message and resolves with its broadcast back to the sender (after COMMIT). */
async function send(socket: Socket, conversationId: number, content: string): Promise<Message> {
  const echoed = nextEvent<Message>(socket, 'message');
  socket.emit('new_message', { conversationId, content });
  return echoed;
}

/**
 * Resolves with every `event` payload the socket receives before a `message` whose content
 * is `sentinel` arrives. Call it before triggering anything.
 */
function receivedBefore<T>(socket: Socket, event: string, sentinel: string): Promise<T[]> {
  const received: T[] = [];
  const listener = (payload: T) => received.push(payload);
  socket.on(event, listener);
  return new Promise((resolve) => {
    const onMessage = (message: Message) => {
      if (message.content !== sentinel) return;
      socket.off(event, listener);
      socket.off('message', onMessage);
      resolve(event === 'message' ? received.filter((m) => (m as Message).content !== sentinel) : received);
    };
    socket.on('message', onMessage);
  });
}

function join(user: TestUser, conversationId: number) {
  return api(server).post(`/api/conversations/${conversationId}/join`).set('Cookie', user.cookie).send({}).expect(200);
}

describe('messages', () => {
  it("reach the conversation's members only, the sender included, with the conversation's id", async () => {
    const alice = await signUp(server);
    const bob = await signUp(server);
    const carol = await signUp(server);
    const plans = await createChannel(server, alice, { name: 'plans' });
    await join(bob, plans.id);
    const [aliceSocket, bobSocket, carolSocket] = await Promise.all(
      [alice, bob, carol].map((user) => connectSocket(server.url, user.cookie)),
    );
    const toCarol = receivedBefore<Message>(carolSocket, 'message', 'sentinel');

    const toBob = nextEvent<Message>(bobSocket, 'message');
    const echoed = await send(aliceSocket, plans.id, 'members only');
    expect(await toBob).toEqual(echoed);
    expect(echoed).toEqual({
      id: expect.any(Number),
      conversationId: plans.id,
      seq: 1,
      userId: alice.user.id,
      username: alice.username,
      content: 'members only',
      createdAt: expect.any(String),
    });

    await send(aliceSocket, await generalId(), 'sentinel');
    expect(await toCarol).toEqual([]);
  });

  it("of a DM reach its two users only, not a third user's sockets", async () => {
    const alice = await signUp(server);
    const bob = await signUp(server);
    const carol = await signUp(server);
    const dm = await api(server).post('/api/dms').set('Cookie', alice.cookie).send({ userId: bob.user.id }).expect(201);
    const [aliceSocket, bobSocket, carolSocket] = await Promise.all(
      [alice, bob, carol].map((user) => connectSocket(server.url, user.cookie)),
    );
    const toCarol = receivedBefore<Message>(carolSocket, 'message', 'sentinel');

    const toBob = nextEvent<Message>(bobSocket, 'message');
    const sent = await send(aliceSocket, dm.body.conversation.id, 'just between us');
    expect(await toBob).toEqual(sent);

    await send(aliceSocket, await generalId(), 'sentinel');
    expect(await toCarol).toEqual([]);
  });

  it('are refused for a conversation I am not in, or that does not exist, without using up a seq', async () => {
    const alice = await signUp(server);
    const bob = await signUp(server);
    const secret = await createChannel(server, alice, { name: 'secret', visibility: 'private' });
    const bobSocket = await connectSocket(server.url, bob.cookie);

    for (const conversationId of [secret.id, MAX_ID]) {
      const refused = nextEvent(bobSocket, 'error');
      bobSocket.emit('new_message', { conversationId, content: 'let me in' });
      expect(await refused).toEqual({ message: 'You are not a member of this conversation.' });
    }

    const { rows } = await pool.query('SELECT last_seq FROM conversations WHERE id = $1', [secret.id]);
    expect(rows).toEqual([{ last_seq: 0 }]);
    expect((await pool.query('SELECT 1 FROM messages')).rows).toEqual([]);
  });

  it('are ignored without a valid conversationId, and the socket keeps working', async () => {
    const alice = await signUp(server);
    const socket = await connectSocket(server.url, alice.cookie);
    const general = await generalId();

    const next = nextEvent<Message>(socket, 'message');
    for (const conversationId of [undefined, null, String(general), general + 0.5, 0, -1, MAX_ID + 1, [general], {}]) {
      socket.emit('new_message', { conversationId, content: 'no conversation' });
    }
    socket.emit('new_message', { conversationId: general, content: 'still here' });

    expect(await next).toMatchObject({ seq: 1, content: 'still here' });
    expect((await pool.query('SELECT content FROM messages')).rows).toEqual([{ content: 'still here' }]);
  });
});

describe('joining a conversation', () => {
  it("puts all of the user's connected sockets in its room at once, and tells each of them", async () => {
    const alice = await signUp(server);
    const bob = await signUp(server);
    const news = await createChannel(server, alice, { name: 'news' });
    const aliceSocket = await connectSocket(server.url, alice.cookie);
    const bobTabs = [await connectSocket(server.url, bob.cookie), await connectSocket(server.url, bob.cookie)];
    const told = Promise.all(bobTabs.map((tab) => nextEvent(tab, 'conversation:joined')));

    await join(bob, news.id);

    expect(await told).toEqual([
      expect.objectContaining({ id: news.id, name: 'news', role: 'member' }),
      expect.objectContaining({ id: news.id, name: 'news', role: 'member' }),
    ]);
    const received = Promise.all(bobTabs.map((tab) => nextEvent<Message>(tab, 'message')));
    const sent = await send(aliceSocket, news.id, 'welcome');
    expect(await received).toEqual([sent, sent]);
  });

  it("puts a socket that connects later in the room from the start", async () => {
    const alice = await signUp(server);
    const bob = await signUp(server);
    const news = await createChannel(server, alice, { name: 'news' });
    await join(bob, news.id);
    const aliceSocket = await connectSocket(server.url, alice.cookie);
    const bobSocket = await connectSocket(server.url, bob.cookie);

    const received = nextEvent<Message>(bobSocket, 'message');
    const sent = await send(aliceSocket, news.id, 'hello');

    expect(await received).toEqual(sent);
  });

  it("puts all of the creator's sockets in a new channel's room, and tells each of them", async () => {
    const alice = await signUp(server);
    const tabs = [await connectSocket(server.url, alice.cookie), await connectSocket(server.url, alice.cookie)];
    const told = Promise.all(tabs.map((tab) => nextEvent(tab, 'conversation:joined')));

    const news = await createChannel(server, alice, { name: 'news' });

    expect(await told).toEqual([news, news]);
    const toOtherTab = nextEvent<Message>(tabs[1], 'message');
    const sent = await send(tabs[0], news.id, 'first!');
    expect(sent).toMatchObject({ conversationId: news.id, seq: 1 });
    expect(await toOtherTab).toEqual(sent);
  });

  it('puts both users of a new DM in its room, each told with the DM named after the other', async () => {
    const alice = await signUp(server);
    const bob = await signUp(server);
    const aliceSocket = await connectSocket(server.url, alice.cookie);
    const bobSocket = await connectSocket(server.url, bob.cookie);
    const toAlice = nextEvent(aliceSocket, 'conversation:joined');
    const toBob = nextEvent(bobSocket, 'conversation:joined');

    const res = await api(server).post('/api/dms').set('Cookie', alice.cookie).send({ userId: bob.user.id }).expect(201);
    const dmId = res.body.conversation.id;

    expect(await toAlice).toEqual(res.body.conversation);
    expect(await toBob).toMatchObject({ id: dmId, type: 'dm', name: alice.username });
    const received = nextEvent<Message>(bobSocket, 'message');
    const sent = await send(aliceSocket, dmId, 'hi bob');
    expect(await received).toEqual(sent);
  });

  it('puts someone added to a private channel in its room, and tells them; others hear nothing', async () => {
    const alice = await signUp(server);
    const bob = await signUp(server);
    const carol = await signUp(server);
    const secret = await createChannel(server, alice, { name: 'secret', visibility: 'private' });
    const aliceSocket = await connectSocket(server.url, alice.cookie);
    const bobSocket = await connectSocket(server.url, bob.cookie);
    const carolSocket = await connectSocket(server.url, carol.cookie);
    const toCarol = ['conversation:joined', 'message', 'user_typing'].map((event) =>
      receivedBefore(carolSocket, event, 'sentinel'),
    );
    const told = nextEvent(bobSocket, 'conversation:joined');

    await api(server)
      .post(`/api/conversations/${secret.id}/members`)
      .set('Cookie', alice.cookie)
      .send({ username: bob.username })
      .expect(204);

    expect(await told).toMatchObject({ id: secret.id, name: 'secret', visibility: 'private', role: 'member' });
    const received = nextEvent<Message>(bobSocket, 'message');
    const sent = await send(aliceSocket, secret.id, 'welcome in');
    expect(await received).toEqual(sent);
    const typing = nextEvent(bobSocket, 'user_typing');
    aliceSocket.emit('typing', { conversationId: secret.id });
    await typing;

    await send(aliceSocket, await generalId(), 'sentinel');
    expect(await Promise.all(toCarol)).toEqual([[], [], []]);
  });

  it('tells nobody when nothing changed: joining a channel I am already in', async () => {
    const alice = await signUp(server);
    const bob = await signUp(server);
    const news = await createChannel(server, alice, { name: 'news' });
    await join(bob, news.id);
    const bobSocket = await connectSocket(server.url, bob.cookie);
    const aliceSocket = await connectSocket(server.url, alice.cookie);
    const told = receivedBefore(bobSocket, 'conversation:joined', 'sentinel');

    await join(bob, news.id);

    await send(aliceSocket, await generalId(), 'sentinel');
    expect(await told).toEqual([]);
  });

  it('tells the user once when several joins race', async () => {
    const alice = await signUp(server);
    const bob = await signUp(server);
    const news = await createChannel(server, alice, { name: 'news' });
    const bobSocket = await connectSocket(server.url, bob.cookie);
    const aliceSocket = await connectSocket(server.url, alice.cookie);
    const told = receivedBefore(bobSocket, 'conversation:joined', 'sentinel');

    await Promise.all(Array.from({ length: 5 }, () => join(bob, news.id)));

    await send(aliceSocket, await generalId(), 'sentinel');
    expect(await told).toEqual([expect.objectContaining({ id: news.id })]);
  });
});

describe('leaving a channel', () => {
  it("takes all of the user's sockets out of its room at once, and tells each of them", async () => {
    const alice = await signUp(server);
    const bob = await signUp(server);
    const news = await createChannel(server, alice, { name: 'news' });
    await join(bob, news.id);
    const aliceSocket = await connectSocket(server.url, alice.cookie);
    const bobTabs = [await connectSocket(server.url, bob.cookie), await connectSocket(server.url, bob.cookie)];
    const told = Promise.all(bobTabs.map((tab) => nextEvent(tab, 'conversation:left')));
    const toBob = bobTabs.map((tab) => receivedBefore<Message>(tab, 'message', 'sentinel'));

    await api(server).post(`/api/conversations/${news.id}/leave`).set('Cookie', bob.cookie).send({}).expect(204);

    expect(await told).toEqual([{ conversationId: news.id }, { conversationId: news.id }]);
    await send(aliceSocket, news.id, 'after bob left');
    await send(aliceSocket, await generalId(), 'sentinel');
    expect(await Promise.all(toBob)).toEqual([[], []]);
  });
});

describe('leaving a private channel', () => {
  it("cuts the member's sockets off from its messages and typing at once", async () => {
    const alice = await signUp(server);
    const bob = await signUp(server);
    const secret = await createChannel(server, alice, { name: 'secret', visibility: 'private' });
    await api(server)
      .post(`/api/conversations/${secret.id}/members`)
      .set('Cookie', alice.cookie)
      .send({ username: bob.username })
      .expect(204);
    const aliceSocket = await connectSocket(server.url, alice.cookie);
    const bobSocket = await connectSocket(server.url, bob.cookie);
    const told = nextEvent(bobSocket, 'conversation:left');
    const toBob = ['message', 'user_typing'].map((event) => receivedBefore(bobSocket, event, 'sentinel'));

    await api(server).post(`/api/conversations/${secret.id}/leave`).set('Cookie', bob.cookie).send({}).expect(204);

    expect(await told).toEqual({ conversationId: secret.id });
    await send(aliceSocket, secret.id, 'after bob left');
    aliceSocket.emit('typing', { conversationId: secret.id });
    await send(aliceSocket, await generalId(), 'sentinel');
    expect(await Promise.all(toBob)).toEqual([[], []]);
    // His socket can no longer post there either.
    const refused = nextEvent(bobSocket, 'error');
    bobSocket.emit('new_message', { conversationId: secret.id, content: 'let me back' });
    expect(await refused).toEqual({ message: 'You are not a member of this conversation.' });
  });
});

describe('typing', () => {
  it("goes to the conversation's other members only: not to non-members, nor to the typist's other tabs", async () => {
    const alice = await signUp(server);
    const bob = await signUp(server);
    const carol = await signUp(server);
    const news = await createChannel(server, alice, { name: 'news' });
    await join(bob, news.id);
    const aliceTab = await connectSocket(server.url, alice.cookie);
    const aliceOtherTab = await connectSocket(server.url, alice.cookie);
    const bobSocket = await connectSocket(server.url, bob.cookie);
    const carolSocket = await connectSocket(server.url, carol.cookie);
    const notToCarol = receivedBefore(carolSocket, 'user_typing', 'sentinel');
    const notToOtherTab = receivedBefore(aliceOtherTab, 'user_typing', 'sentinel');

    const toBob = nextEvent(bobSocket, 'user_typing');
    aliceTab.emit('typing', { conversationId: news.id });
    expect(await toBob).toEqual({ conversationId: news.id, username: alice.username });

    await send(aliceTab, await generalId(), 'sentinel');
    expect(await notToCarol).toEqual([]);
    expect(await notToOtherTab).toEqual([]);
  });

  it("is ignored for a conversation the socket is not in, or without a valid conversationId", async () => {
    const alice = await signUp(server);
    const carol = await signUp(server);
    const secret = await createChannel(server, alice, { name: 'secret', visibility: 'private' });
    const aliceSocket = await connectSocket(server.url, alice.cookie);
    const carolSocket = await connectSocket(server.url, carol.cookie);
    const toAlice = receivedBefore(aliceSocket, 'user_typing', 'sentinel');

    for (const payload of [{ conversationId: secret.id }, { conversationId: String(secret.id) }, {}, null, 'typing']) {
      carolSocket.emit('typing', payload);
    }

    await send(carolSocket, await generalId(), 'sentinel');
    expect(await toAlice).toEqual([]);
  });

  it('starts again with the next keystroke after the typist sends a message', async () => {
    const alice = await signUp(server);
    const bob = await signUp(server);
    const conversationId = await generalId();
    const aliceSocket = await connectSocket(server.url, alice.cookie);
    const bobSocket = await connectSocket(server.url, bob.cookie);
    const first = nextEvent(bobSocket, 'user_typing');
    aliceSocket.emit('typing', { conversationId });
    await first;

    // Bob's client stops showing Alice as typing when her message arrives...
    const received = nextEvent(bobSocket, 'message');
    aliceSocket.emit('new_message', { conversationId, content: 'done typing' });
    await received;

    // ...so her next keystroke, well within the 3 s of her first burst, says so again.
    const again = nextEvent(bobSocket, 'user_typing');
    aliceSocket.emit('typing', { conversationId });
    expect(await again).toEqual({ conversationId, username: alice.username });
  });

  it("is not cleared when another of the typist's tabs disconnects", async () => {
    const alice = await signUp(server);
    const bob = await signUp(server);
    const conversationId = await generalId();
    const typingTab = await connectSocket(server.url, alice.cookie);
    const idleTab = await connectSocket(server.url, alice.cookie);
    const bobSocket = await connectSocket(server.url, bob.cookie);
    const typing = nextEvent(bobSocket, 'user_typing');
    typingTab.emit('typing', { conversationId });
    await typing;

    // The disconnect handler clears the tab's own typing, then sends online_count: once
    // Bob has the count, a user_stop_typing from that disconnect can no longer come.
    const stopped: unknown[] = [];
    bobSocket.on('user_stop_typing', (payload) => stopped.push(payload));
    const counted = nextEvent(bobSocket, 'online_count');
    idleTab.disconnect();
    await counted;

    expect(stopped).toEqual([]);
  });

  it('is cleared in every conversation the typist was typing in when they disconnect', async () => {
    const alice = await signUp(server);
    const bob = await signUp(server);
    const news = await createChannel(server, alice, { name: 'news' });
    await join(bob, news.id);
    const general = await generalId();
    const aliceSocket = await connectSocket(server.url, alice.cookie);
    const bobSocket = await connectSocket(server.url, bob.cookie);
    const typing = collectEvents(bobSocket, 'user_typing', 2);
    aliceSocket.emit('typing', { conversationId: news.id });
    aliceSocket.emit('typing', { conversationId: general });
    await typing;

    // Disconnecting clears the indicators at once, so no 3-second timer is involved.
    const stopped = collectEvents<{ conversationId: number }>(bobSocket, 'user_stop_typing', 2);
    aliceSocket.disconnect();

    expect((await stopped).sort((a, b) => a.conversationId - b.conversationId)).toEqual(
      [
        { conversationId: general, username: alice.username },
        { conversationId: news.id, username: alice.username },
      ].sort((a, b) => a.conversationId - b.conversationId),
    );
  });
});

describe('connecting', () => {
  it('puts the socket in the room of a conversation joined while it was connecting', async () => {
    const alice = await signUp(server);
    const bob = await signUp(server);
    const news = await createChannel(server, alice, { name: 'news' });
    const aliceSocket = await connectSocket(server.url, alice.cookie);
    const query = pool.query.bind(pool);
    const lookups: Promise<unknown>[] = [];
    vi.spyOn(pool, 'query').mockImplementation(((text: string, values?: unknown[]) => {
      const result = query(text, values);
      if (!text.startsWith('SELECT conversation_id FROM conversation_members WHERE user_id')) return result;
      lookups.push(result);
      // Bob joins #news after his connecting socket has looked up his conversations, and
      // before it is connected: the join's socketsJoin() cannot reach it.
      return lookups.length === 1 ? result.then(async (rows) => (await join(bob, news.id), rows)) : result;
    }) as never);

    const bobSocket = await connectSocket(server.url, bob.cookie);
    // Connected, the socket saw that memberships changed meanwhile and looked again.
    expect(lookups).toHaveLength(2);
    await lookups[1];
    await new Promise((resolve) => setImmediate(resolve)); // lets its rooms be joined
    vi.restoreAllMocks();

    const received = nextEvent<Message>(bobSocket, 'message');
    const sent = await send(aliceSocket, news.id, 'you made it');
    expect(await received).toEqual(sent);
  });

  // The client logs out on an "Authentication" connect_error; an outage must not do that.
  it('is refused with a server error, not an authentication error, when the conversation lookup fails', async () => {
    const alice = await signUp(server);
    const query = pool.query.bind(pool);
    const logged = vi.spyOn(logger, 'error');
    // The session lookup succeeds; the next query, the user's conversations, fails.
    vi.spyOn(pool, 'query')
      .mockImplementationOnce(((...args: Parameters<typeof query>) => query(...args)) as typeof pool.query)
      .mockRejectedValueOnce(new Error('db down'));

    const error = await connectSocket(server.url, alice.cookie).catch((err: Error) => err);

    expect(error).toMatchObject({ message: 'Server error: could not load your conversations' });
    expect(logged).toHaveBeenCalledOnce();

    // The refusal is not final: once the database answers again, the same session connects.
    // (The client retries such a handshake itself: client/src/lib/reconnect.ts.)
    const socket = await connectSocket(server.url, alice.cookie);
    expect(socket.connected).toBe(true);
  });
});
