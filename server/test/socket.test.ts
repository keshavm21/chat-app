import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import pool from '../db/connection.js';
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
});

afterAll(async () => {
  await server.close();
});

describe('Socket.io handshake', () => {
  it('accepts a connection with a valid token', async () => {
    const user = await signUp(server);

    const socket = await connectSocket(server.url, user.token);

    expect(socket.connected).toBe(true);
  });

  it('rejects a connection without a token', async () => {
    await expect(connectSocket(server.url)).rejects.toThrow('Authentication error: no token provided');
  });

  it('rejects a connection with an invalid token', async () => {
    await expect(connectSocket(server.url, 'not-a-valid-token')).rejects.toThrow(
      'Authentication error: invalid or expired token',
    );
  });
});

describe('new_message', () => {
  it('stores the trimmed message and emits it to every client in the REST shape', async () => {
    const alice = await signUp(server);
    const bob = await signUp(server);
    const aliceSocket = await connectSocket(server.url, alice.token);
    const bobSocket = await connectSocket(server.url, bob.token);

    const toBob = nextEvent(bobSocket, 'message');
    const toAlice = nextEvent(aliceSocket, 'message');
    aliceSocket.emit('new_message', { content: '  hello bob  ' });
    const [received, echoed] = await Promise.all([toBob, toAlice]);

    expect(received).toEqual({
      id: expect.any(Number),
      userId: alice.user.id,
      username: alice.username,
      content: 'hello bob',
      createdAt: expect.any(String),
    });
    expect(echoed).toEqual(received); // the sender gets the same broadcast

    const { rows } = await pool.query('SELECT user_id, username, content FROM messages');
    expect(rows).toEqual([{ user_id: alice.user.id, username: alice.username, content: 'hello bob' }]);

    const history = await request(server.httpServer)
      .get('/api/messages')
      .set('Authorization', `Bearer ${bob.token}`);
    expect(history.body.messages).toEqual([received]);
  });

  // A null payload used to throw inside the handler, and the unhandled rejection
  // crashed the whole server.
  it('ignores a payload without text content, including null, and keeps working', async () => {
    const alice = await signUp(server);
    const socket = await connectSocket(server.url, alice.token);

    const next = nextEvent<{ content: string }>(socket, 'message');
    for (const payload of [null, 'text', 42, {}, { content: 42 }, { content: '' }, { content: ' \n ' }]) {
      socket.emit('new_message', payload);
    }
    socket.emit('new_message', { content: 'still here' });

    // The first broadcast is the real message: nothing before it was stored.
    expect(await next).toMatchObject({ content: 'still here' });
    const { rows } = await pool.query('SELECT content FROM messages');
    expect(rows).toEqual([{ content: 'still here' }]);
  });
});

describe('typing', () => {
  it('tells other clients who is typing, and clears it when the typist disconnects', async () => {
    const alice = await signUp(server);
    const bob = await signUp(server);
    const aliceSocket = await connectSocket(server.url, alice.token);
    const bobSocket = await connectSocket(server.url, bob.token);

    const typing = nextEvent(bobSocket, 'user_typing');
    aliceSocket.emit('typing');
    expect(await typing).toBe(alice.username);

    // Disconnecting clears the indicator immediately, so no 3-second timer is involved.
    const stopped = nextEvent(bobSocket, 'user_stop_typing');
    aliceSocket.disconnect();
    expect(await stopped).toBe(alice.username);
  });
});
