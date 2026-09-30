import type { AddressInfo } from 'net';
import request from 'supertest';
import { parseSetCookie } from 'cookie';
import { io as ioClient, type Socket } from 'socket.io-client';
import { createApp } from '../app.js';
import pool from '../db/connection.js';
import { allowedOrigin } from '../http/csrf.js';
import type { RateLimits } from '../http/rateLimits.js';
import { hashSessionToken, sessionCookie } from '../lib/sessions.js';

// Test files sign up, log in and search from one IP far more often than the real limits
// allow. rateLimits.test.ts passes the real ones (RATE_LIMITS) or low ones instead.
const TEST_RATE_LIMITS: RateLimits = {
  login: { limit: 100_000, windowMs: 60_000 },
  signup: { limit: 100_000, windowMs: 60_000 },
  userSearch: { limit: 100_000, windowMs: 60_000 },
  channelCreation: { limit: 100_000, windowMs: 60_000 },
};

/**
 * Starts the real app (Express + Socket.io + its timers) on a random free port, with
 * createApp's options: `rateLimits` (default: high enough never to matter), `trustProxy`
 * and `clientDist` (spa.test.ts uses a fixture build).
 */
export async function startServer(options: { rateLimits?: RateLimits; trustProxy?: number; clientDist?: string } = {}) {
  const { app, httpServer, io, stopTimers } = createApp({ rateLimits: TEST_RATE_LIMITS, ...options });
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const { port } = httpServer.address() as AddressInfo;

  return {
    app,
    httpServer,
    io,
    url: `http://localhost:${port}`,
    // Stops the app's timers; then io.close() disconnects every socket and closes the HTTP server.
    close: async () => {
      await stopTimers();
      await new Promise<void>((resolve) => io.close(() => resolve()));
    },
  };
}

export type TestServer = Awaited<ReturnType<typeof startServer>>;

/**
 * supertest against a test server that sends the app's Origin, as the browser app does:
 * the server refuses state-changing requests without it (403). Bodies are JSON: use
 * `.send(object)`, and `.send({})` when there is nothing to send, like the app (else 415).
 */
export function api(server: TestServer) {
  const agent = request(server.httpServer);
  return {
    get: (url: string) => agent.get(url).set('Origin', allowedOrigin),
    post: (url: string) => agent.post(url).set('Origin', allowedOrigin),
    put: (url: string) => agent.put(url).set('Origin', allowedOrigin),
  };
}

/**
 * The session cookie a response sets, as the `name=value` a later request sends in
 * its Cookie header (tests have no cookie jar). Throws if the response sets none.
 */
export function sessionCookieOf(res: request.Response): string {
  const setCookies = res.get('Set-Cookie') ?? [];
  const cookie = setCookies.map((header) => parseSetCookie(header)).find((c) => c.name === sessionCookie.name);
  if (!cookie?.value) throw new Error('The response sets no session cookie');
  return `${cookie.name}=${cookie.value}`;
}

/** The SHA-256 of a session cookie's token: its sessions.token_hash. */
export function sessionHashOf(cookie: string): Buffer {
  return hashSessionToken(cookie.slice(cookie.indexOf('=') + 1));
}

/** Puts a session's `column` this far (a Postgres interval, e.g. '8 days') in the past. */
export async function setSessionAgo(cookie: string, column: 'expires_at' | 'last_seen_at', interval: string) {
  await pool.query(`UPDATE sessions SET ${column} = now() - $2::interval WHERE token_hash = $1`, [
    sessionHashOf(cookie),
    interval,
  ]);
}

let userCount = 0;

/**
 * Creates a user through POST /api/auth/signup (named `username`, or user1, user2, …) and
 * returns its credentials, user and session cookie.
 */
export async function signUp(server: TestServer, { username }: { username?: string } = {}) {
  userCount += 1;
  const name = username ?? `user${userCount}`;
  const credentials = {
    username: name,
    email: `${name}@example.test`,
    password: 'password123',
  };
  const res = await api(server).post('/api/auth/signup').send(credentials).expect(201);
  return {
    ...credentials,
    /** For `.set('Cookie', cookie)` and connectSocket(). */
    cookie: sessionCookieOf(res),
    user: res.body.user as { id: number; username: string; email: string },
  };
}

/** The id of #general, re-seeded before every test (looked up by name, never hard-coded). */
export async function generalId(): Promise<number> {
  const { rows } = await pool.query(`SELECT id FROM conversations WHERE type = 'channel' AND visibility = 'public' AND name = 'general'`);
  return rows[0].id;
}

/** A conversation summary as the API returns it (repositories/conversations.ts), as JSON. */
export interface ConversationJson {
  id: number;
  type: 'channel' | 'dm';
  visibility: 'public' | 'private' | null;
  name: string;
  topic: string | null;
  role: 'owner' | 'admin' | 'member';
  lastSeq: number;
  lastReadSeq: number;
  unreadCount: number;
  lastMessageAt: string | null;
  lastActivityAt: string;
}

/** Creates a channel through POST /api/channels as `user` and returns its summary. */
export async function createChannel(
  server: TestServer,
  user: { cookie: string },
  channel: { name: string; topic?: string | null; visibility?: 'public' | 'private' },
): Promise<ConversationJson> {
  const res = await api(server).post('/api/channels').set('Cookie', user.cookie).send(channel).expect(201);
  return res.body.conversation;
}

/**
 * Stores `count` messages by `authorId` in a conversation without a socket, numbered and
 * counted as the send transaction does: the next seqs, last_seq and last_message_at.
 * Nobody's read position moves.
 */
export async function postMessages(conversationId: number, authorId: number, count: number) {
  await pool.query(
    `WITH c AS (
       UPDATE conversations SET last_seq = last_seq + $3, last_message_at = now()
       WHERE id = $1
       RETURNING last_seq
     )
     INSERT INTO messages (conversation_id, seq, author_id, client_id, content)
     SELECT $1, s, $2, gen_random_uuid(), 'message ' || s
     FROM c, generate_series(c.last_seq - $3 + 1, c.last_seq) AS s`,
    [conversationId, authorId, count],
  );
}

const openSockets = new Set<Socket>();

/**
 * Connects a Socket.io client over WebSocket with a session cookie (or none), from the
 * app's origin unless `origin` says otherwise (null: no Origin header). Rejects with the
 * server's connect_error.
 */
export function connectSocket(url: string, cookie?: string, { origin = allowedOrigin }: { origin?: string | null } = {}): Promise<Socket> {
  const socket = ioClient(url, {
    // The handshake carries the cookie and the Origin, as a browser's would.
    extraHeaders: {
      ...(origin === null ? {} : { Origin: origin }),
      ...(cookie === undefined ? {} : { Cookie: cookie }),
    },
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
  });
  openSockets.add(socket);

  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

export function disconnectAllSockets() {
  for (const socket of openSockets) socket.disconnect();
  openSockets.clear();
}

/** Resolves with the first payload of `event`. Call it before triggering the event. */
export function nextEvent<T>(socket: Socket, event: string): Promise<T> {
  return new Promise((resolve) => socket.once(event, resolve));
}

/** Resolves with the first `count` payloads of `event`, in arrival order. Call it before triggering them. */
export function collectEvents<T>(socket: Socket, event: string, count: number): Promise<T[]> {
  const received: T[] = [];
  return new Promise((resolve) => {
    const listener = (payload: T) => {
      received.push(payload);
      if (received.length === count) {
        socket.off(event, listener);
        resolve(received);
      }
    };
    socket.on(event, listener);
  });
}
