import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io-client';
import pool from '../db/connection.js';
import { SESSION_SWEEP_INTERVAL_MS } from '../lib/limits.js';
import { logger } from '../lib/logger.js';
import { sweepSessions } from '../socket/sessionSweep.js';
import {
  api,
  connectSocket,
  disconnectAllSockets,
  nextEvent,
  sessionCookieOf,
  sessionHashOf,
  setSessionAgo,
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
  vi.restoreAllMocks();
  vi.useRealTimers();
});

afterAll(async () => {
  await server.close();
});

async function login(user: { email: string; password: string }) {
  return sessionCookieOf(await api(server).post('/api/auth/login').send(user).expect(200));
}

async function deleteSession(cookie: string) {
  await pool.query('DELETE FROM sessions WHERE token_hash = $1', [sessionHashOf(cookie)]);
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
    await api(server).post('/api/auth/logout').send({}).set('Cookie', alice.cookie).expect(204);

    expect(await disconnected).toEqual(['io server disconnect', 'io server disconnect']);
    await roundTrip(otherDevice, 'still connected');
  });
});

describe('sweepSessions', () => {
  it('disconnects the sockets of sessions that were deleted, expired or went idle, and keeps the others', async () => {
    const [alice, bob, carol, dave] = [await signUp(server), await signUp(server), await signUp(server), await signUp(server)];
    const aliceSocket = await connectSocket(server.url, alice.cookie);
    const ended = [
      await connectSocket(server.url, bob.cookie),
      await connectSocket(server.url, carol.cookie),
      await connectSocket(server.url, dave.cookie),
    ];
    await deleteSession(bob.cookie); // revoked
    await setSessionAgo(carol.cookie, 'expires_at', '1 second'); // expired
    await setSessionAgo(dave.cookie, 'last_seen_at', '8 days'); // idle
    const disconnected = Promise.all(ended.map((socket) => nextEvent(socket, 'disconnect')));

    await sweepSessions(server.io);

    expect(await disconnected).toEqual(['io server disconnect', 'io server disconnect', 'io server disconnect']);
    await roundTrip(aliceSocket, 'still connected');
  });

  it("counts an open socket as use: its session's last_seen_at moves to now", async () => {
    const alice = await signUp(server);
    await connectSocket(server.url, alice.cookie);
    await setSessionAgo(alice.cookie, 'last_seen_at', '6 days');

    await sweepSessions(server.io);

    const { rows } = await pool.query(
      `SELECT now() - last_seen_at < interval '1 minute' AS just_now FROM sessions WHERE token_hash = $1`,
      [sessionHashOf(alice.cookie)],
    );
    expect(rows).toEqual([{ just_now: true }]);
  });

  it('deletes expired and idle sessions, connected or not, and keeps valid ones', async () => {
    const valid = await signUp(server);
    const expired = await signUp(server);
    const idle = await signUp(server);
    const connectedExpired = await signUp(server);
    await connectSocket(server.url, connectedExpired.cookie);
    await setSessionAgo(expired.cookie, 'expires_at', '1 second');
    await setSessionAgo(idle.cookie, 'last_seen_at', '8 days');
    await setSessionAgo(connectedExpired.cookie, 'expires_at', '1 second');

    await sweepSessions(server.io);

    const { rows } = await pool.query('SELECT user_id FROM sessions');
    expect(rows).toEqual([{ user_id: valid.user.id }]);
  });

  it('checks every connected session in one query, then deletes ended ones in another', async () => {
    for (let i = 0; i < 3; i += 1) {
      await connectSocket(server.url, (await signUp(server)).cookie);
    }
    const query = vi.spyOn(pool, 'query');

    await sweepSessions(server.io);

    expect(query).toHaveBeenCalledTimes(2);
  });
});

describe('the sweep timer', () => {
  // Only the intervals are faked: the sweep's own timer is the one setInterval of the app.
  it('sweeps every 5 minutes, and close() leaves no timer behind', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const own = await startServer();
    expect(vi.getTimerCount()).toBe(1);
    const alice = await signUp(own);
    const socket = await connectSocket(own.url, alice.cookie);
    await deleteSession(alice.cookie);
    const disconnected = nextEvent(socket, 'disconnect');

    await vi.advanceTimersByTimeAsync(SESSION_SWEEP_INTERVAL_MS);

    expect(await disconnected).toBe('io server disconnect');
    await own.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('logs a failed sweep instead of crashing the server, and keeps its timer', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const own = await startServer();
    const logged = new Promise<unknown[]>((resolve) => {
      vi.spyOn(logger, 'error').mockImplementation((...args: unknown[]) => resolve(args));
    });
    vi.spyOn(pool, 'query').mockRejectedValueOnce(new Error('db down'));

    await vi.advanceTimersByTimeAsync(SESSION_SWEEP_INTERVAL_MS);

    expect(await logged).toEqual([{ err: expect.objectContaining({ message: 'db down' }) }, 'Session sweep failed']);
    expect(vi.getTimerCount()).toBe(1);
    await own.close();
  });
});
