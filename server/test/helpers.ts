import type { AddressInfo } from 'net';
import request from 'supertest';
import { io as ioClient, type Socket } from 'socket.io-client';
import { createApp } from '../app.js';

/** Starts the real app (Express + Socket.io) on a random free port. */
export async function startServer() {
  const { app, httpServer, io } = createApp();
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const { port } = httpServer.address() as AddressInfo;

  return {
    app,
    httpServer,
    io,
    url: `http://localhost:${port}`,
    // io.close() disconnects every socket and closes the HTTP server.
    close: () => new Promise<void>((resolve) => io.close(() => resolve())),
  };
}

export type TestServer = Awaited<ReturnType<typeof startServer>>;

let userCount = 0;

/** Creates a user through POST /api/auth/signup and returns its credentials, user and token. */
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
    token: res.body.token as string,
    user: res.body.user as { id: number; username: string; email: string },
  };
}

const openSockets = new Set<Socket>();

/** Connects a Socket.io client; rejects with the server's connect_error. */
export function connectSocket(url: string, token?: string): Promise<Socket> {
  const socket = ioClient(url, {
    auth: token === undefined ? {} : { token },
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
