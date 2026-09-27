import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Socket } from 'socket.io-client';
import {
  connectSocket,
  disconnectAllSockets,
  nextEvent,
  sessionCookieOf,
  signUp,
  startServer,
  type TestServer,
} from './helpers.js';

// A session that ends takes its sockets with it (docs/v2-design.md §6, audit §7.8).

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

async function login(user: { email: string; password: string }) {
  return sessionCookieOf(await request(server.httpServer).post('/api/auth/login').send(user).expect(200));
}

/** Resolves once `socket` has sent a message and received its broadcast: it is still connected. */
async function roundTrip(socket: Socket, content: string) {
  const echoed = nextEvent<{ content: string }>(socket, 'message');
  socket.emit('new_message', { content });
  expect(await echoed).toMatchObject({ content });
}

describe('logout', () => {
  it("disconnects every socket of that session, and none of the user's other sessions", async () => {
    const alice = await signUp(server);
    const otherSession = await login(alice);
    const tab1 = await connectSocket(server.url, alice.cookie);
    const tab2 = await connectSocket(server.url, alice.cookie);
    const otherDevice = await connectSocket(server.url, otherSession);

    const disconnected = Promise.all([nextEvent(tab1, 'disconnect'), nextEvent(tab2, 'disconnect')]);
    await request(server.httpServer).post('/api/auth/logout').set('Cookie', alice.cookie).expect(204);

    expect(await disconnected).toEqual(['io server disconnect', 'io server disconnect']);
    await roundTrip(otherDevice, 'still connected');
  });
});
