import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import pool from '../db/connection.js';
import { logger } from '../lib/logger.js';
import {
  connectSocket,
  disconnectAllSockets,
  nextEvent,
  signUp,
  startServer,
  type TestServer,
} from './helpers.js';

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

describe('Socket.io handshake', () => {
  it('accepts a connection with a valid session cookie', async () => {
    const user = await signUp(server);

    const socket = await connectSocket(server.url, user.cookie);

    expect(socket.connected).toBe(true);
  });

  it('rejects a connection without a session cookie', async () => {
    await expect(connectSocket(server.url)).rejects.toThrow('Authentication error: no token provided');
    await expect(connectSocket(server.url, 'other=cookie')).rejects.toThrow('Authentication error: no token provided');
  });

  it('rejects a connection with an unknown session', async () => {
    await expect(connectSocket(server.url, 'relay_session=not-a-session')).rejects.toThrow(
      'Authentication error: invalid or expired token',
    );
  });

  it('rejects a connection whose session has expired', async () => {
    const user = await signUp(server);
    await pool.query(`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE user_id = $1`, [user.user.id]);

    await expect(connectSocket(server.url, user.cookie)).rejects.toThrow('Authentication error: invalid or expired token');
  });

  // The client logs out on an "Authentication" connect_error; an outage must not do that.
  it('rejects without an authentication error when the session lookup fails', async () => {
    const user = await signUp(server);
    const logged = vi.spyOn(logger, 'error');
    vi.spyOn(pool, 'query').mockRejectedValueOnce(new Error('db down'));

    const error = await connectSocket(server.url, user.cookie).catch((err: Error) => err);

    expect(error).toMatchObject({ message: 'Server error: could not check the session' });
    expect(logged).toHaveBeenCalledOnce();
  });
});

describe('new_message', () => {
  it('stores the trimmed message and emits it to every client in the REST shape', async () => {
    const alice = await signUp(server);
    const bob = await signUp(server);
    const aliceSocket = await connectSocket(server.url, alice.cookie);
    const bobSocket = await connectSocket(server.url, bob.cookie);

    const toBob = nextEvent(bobSocket, 'message');
    const toAlice = nextEvent(aliceSocket, 'message');
    aliceSocket.emit('new_message', { content: '  hello bob  ' });
    const [received, echoed] = await Promise.all([toBob, toAlice]);

    expect(received).toEqual({
      id: expect.any(Number),
      seq: 1,
      userId: alice.user.id,
      username: alice.username,
      content: 'hello bob',
      createdAt: expect.any(String),
    });
    expect(echoed).toEqual(received); // the sender gets the same broadcast

    const { rows } = await pool.query(
      `SELECT c.name, m.seq, m.author_id, m.content
       FROM messages m JOIN conversations c ON c.id = m.conversation_id`,
    );
    expect(rows).toEqual([{ name: 'general', seq: 1, author_id: alice.user.id, content: 'hello bob' }]);

    const history = await request(server.httpServer)
      .get('/api/messages')
      .set('Cookie', bob.cookie);
    expect(history.body.messages).toEqual([received]);
  });

  it("numbers #general's messages 1, 2, … and advances its last_seq and last_message_at", async () => {
    const alice = await signUp(server);
    const socket = await connectSocket(server.url, alice.cookie);

    const seqs: number[] = [];
    for (const content of ['one', 'two', 'three']) {
      const broadcast = nextEvent<{ seq: number }>(socket, 'message');
      socket.emit('new_message', { content });
      seqs.push((await broadcast).seq);
    }

    expect(seqs).toEqual([1, 2, 3]);
    const { rows } = await pool.query(
      `SELECT last_seq, last_message_at = (SELECT max(created_at) FROM messages) AS last_message_at_is_latest
       FROM conversations WHERE name = 'general'`,
    );
    expect(rows).toEqual([{ last_seq: 3, last_message_at_is_latest: true }]);
    // Each message gets its own server-generated client_id.
    const clientIds = await pool.query('SELECT DISTINCT client_id FROM messages');
    expect(clientIds.rows).toHaveLength(3);
  });

  // A null payload used to throw inside the handler, and the unhandled rejection
  // crashed the whole server.
  it('ignores a payload without text content, including null, and keeps working', async () => {
    const alice = await signUp(server);
    const socket = await connectSocket(server.url, alice.cookie);

    const next = nextEvent<{ seq: number; content: string }>(socket, 'message');
    for (const payload of [null, 'text', 42, {}, { content: 42 }, { content: '' }, { content: ' \n ' }]) {
      socket.emit('new_message', payload);
    }
    socket.emit('new_message', { content: 'still here' });

    // The first broadcast is the real message, with the first seq: nothing before it was stored.
    expect(await next).toMatchObject({ seq: 1, content: 'still here' });
    const { rows } = await pool.query('SELECT content FROM messages');
    expect(rows).toEqual([{ content: 'still here' }]);
  });
});

describe('typing', () => {
  it('tells other clients who is typing, and clears it when the typist disconnects', async () => {
    const alice = await signUp(server);
    const bob = await signUp(server);
    const aliceSocket = await connectSocket(server.url, alice.cookie);
    const bobSocket = await connectSocket(server.url, bob.cookie);

    const typing = nextEvent(bobSocket, 'user_typing');
    aliceSocket.emit('typing');
    expect(await typing).toBe(alice.username);

    // Disconnecting clears the indicator immediately, so no 3-second timer is involved.
    const stopped = nextEvent(bobSocket, 'user_stop_typing');
    aliceSocket.disconnect();
    expect(await stopped).toBe(alice.username);
  });
});
