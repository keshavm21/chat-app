import type { AddressInfo } from 'net';
import request from 'supertest';
import { parseSetCookie } from 'cookie';
import { io as ioClient, type Socket } from 'socket.io-client';
import { createApp } from '../app.js';
import pool from '../db/connection.js';
import { hashSessionToken, sessionCookie } from '../lib/sessions.js';

/** Starts the real app (Express + Socket.io + the session sweep) on a random free port. */
export async function startServer() {
  const { app, httpServer, io, sessionSweep } = createApp();
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const { port } = httpServer.address() as AddressInfo;

  return {
    app,
    httpServer,
    io,
    url: `http://localhost:${port}`,
    // Stops the session sweep; then io.close() disconnects every socket and closes the HTTP server.
    close: async () => {
      await sessionSweep.stop();
      await new Promise<void>((resolve) => io.close(() => resolve()));
    },
  };
}

export type TestServer = Awaited<ReturnType<typeof startServer>>;

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

/** Creates a user through POST /api/auth/signup and returns its credentials, user and session cookie. */
export async function signUp(server: TestServer) {
  userCount += 1;
  const credentials = {
    username: `user${userCount}`,
    email: `user${userCount}@example.test`,
    password: 'password123',
  };
  const res = await request(server.httpServer).post('/api/auth/signup').send(credentials).expect(201);
  return {
    ...credentials,
    /** For `.set('Cookie', cookie)` and connectSocket(). */
    cookie: sessionCookieOf(res),
    user: res.body.user as { id: number; username: string; email: string },
  };
}

const openSockets = new Set<Socket>();

/** Connects a Socket.io client with a session cookie (or none); rejects with the server's connect_error. */
export function connectSocket(url: string, cookie?: string): Promise<Socket> {
  const socket = ioClient(url, {
    // The handshake carries the cookie, as a browser's would.
    extraHeaders: cookie === undefined ? {} : { Cookie: cookie },
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
