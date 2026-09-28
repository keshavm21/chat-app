import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import pool from '../db/connection.js';
import { allowedOrigin } from '../http/csrf.js';
import { logger } from '../lib/logger.js';
import { api, connectSocket, disconnectAllSockets, signUp, startServer, type TestServer } from './helpers.js';

// CSRF defenses and security headers (docs/v2-design.md §6). Requests here set their
// Origin by hand; everywhere else, the helpers send the app's.

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

const FORBIDDEN = { error: { code: 'FORBIDDEN', message: 'Request origin is not allowed.' } };
const NOT_JSON = { error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Request body must be JSON.' } };

// Origins another site could send: the attacker's, a sandboxed page's ("null"), and
// near-misses of the app's (another port, another scheme, a lookalike host).
const FOREIGN_ORIGINS = [
  'https://evil.example',
  'null',
  'http://localhost:5174',
  'https://localhost:5173',
  'http://localhost:5173.evil.example',
];

/** A request with the given Origin header, or none when `origin` is undefined. */
function from(origin: string | undefined, method: 'get' | 'post' | 'put' | 'patch' | 'delete', url: string) {
  const req = request(server.httpServer)[method](url);
  return origin === undefined ? req : req.set('Origin', origin);
}

async function userCount() {
  const { rows } = await pool.query('SELECT count(*)::int AS count FROM users');
  return rows[0].count;
}

describe('the Origin check on state-changing requests', () => {
  it.each(['post', 'put', 'patch', 'delete'] as const)('refuses %s from another origin, or without one, with 403', async (method) => {
    for (const origin of [undefined, ...FOREIGN_ORIGINS]) {
      const res = await from(origin, method, '/api/auth/login').send({});

      expect(res.status, `Origin: ${origin}`).toBe(403);
      expect(res.body).toEqual(FORBIDDEN);
    }
  });

  it('does nothing for a refused request: no user, no session, no logout', async () => {
    const alice = await signUp(server);
    const evil = 'https://evil.example';

    const signup = await from(evil, 'post', '/api/auth/signup')
      .send({ username: 'mallory', email: 'mallory@example.test', password: 'password123' });
    const login = await from(evil, 'post', '/api/auth/login').send({ email: alice.email, password: alice.password });
    const logout = await from(evil, 'post', '/api/auth/logout').set('Cookie', alice.cookie).send({});

    expect([signup.status, login.status, logout.status]).toEqual([403, 403, 403]);
    expect(await userCount()).toBe(1);
    expect(login.get('Set-Cookie')).toBeUndefined();
    expect(logout.get('Set-Cookie')).toBeUndefined();
    expect((await api(server).get('/api/auth/me').set('Cookie', alice.cookie)).status).toBe(200); // still logged in

    // The same login from the app's origin works.
    const allowed = await from(allowedOrigin, 'post', '/api/auth/login').send({ email: alice.email, password: alice.password });
    expect(allowed.status).toBe(200);
  });

  it('lets GET requests through without an Origin', async () => {
    const alice = await signUp(server);

    expect((await request(server.httpServer).get('/api/ping')).status).toBe(200);
    const me = await request(server.httpServer).get('/api/auth/me').set('Cookie', alice.cookie);
    expect(me.status).toBe(200);
    expect(me.body).toEqual({ user: alice.user });
  });

  it("answers CORS preflights for the app's origin only", async () => {
    for (const origin of [allowedOrigin, 'https://evil.example']) {
      const res = await request(server.httpServer)
        .options('/api/auth/login')
        .set('Origin', origin)
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'content-type');

      expect(res.status).toBe(204);
      // Always the app's origin, so a browser on another site refuses to send the request.
      expect(res.get('Access-Control-Allow-Origin')).toBe(allowedOrigin);
      expect(res.get('Access-Control-Allow-Credentials')).toBe('true');
    }
  });
});

describe('JSON-only bodies on state-changing requests', () => {
  // The body types an HTML form or a plain fetch() can send cross-site without a preflight.
  it.each([
    ['a form', 'application/x-www-form-urlencoded', 'email=a%40example.test&password=password123'],
    ['text/plain (JSON in disguise)', 'text/plain', '{"email":"a@example.test","password":"password123"}'],
    ['multipart', 'multipart/form-data; boundary=x', '--x--'],
  ])('refuses %s from the app’s origin with 415', async (_case, contentType, body) => {
    const res = await api(server).post('/api/auth/login').set('Content-Type', contentType).send(body);

    expect(res.status).toBe(415);
    expect(res.body).toEqual(NOT_JSON);
  });

  it('refuses a request without a body, and accepts JSON with a charset', async () => {
    const alice = await signUp(server);

    const empty = await api(server).post('/api/auth/logout').set('Cookie', alice.cookie);
    expect(empty.status).toBe(415);
    expect(empty.body).toEqual(NOT_JSON);

    const json = await api(server)
      .post('/api/auth/logout')
      .set('Cookie', alice.cookie)
      .set('Content-Type', 'application/json; charset=utf-8')
      .send('{}');
    expect(json.status).toBe(204);
  });

  it('checks the Origin first: a foreign form post gets 403, not 415', async () => {
    const res = await from('https://evil.example', 'post', '/api/auth/login')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('email=a%40example.test');

    expect(res.status).toBe(403);
    expect(res.body).toEqual(FORBIDDEN);
  });
});

describe('the Origin check on the socket handshake', () => {
  it.each([
    ['another origin', 'https://evil.example'],
    ['no Origin', null],
  ])('refuses a WebSocket handshake from %s, before the session is looked up', async (_case, origin) => {
    const alice = await signUp(server);
    const query = vi.spyOn(pool, 'query');
    const warn = vi.spyOn(logger, 'warn');

    const error = await connectSocket(server.url, alice.cookie, { origin }).catch((err: Error) => err);

    // engine.io answers the refused upgrade with 400, so the client only sees a transport error.
    expect(error).toMatchObject({ message: 'websocket error', description: expect.objectContaining({ message: 'Unexpected server response: 400' }) });
    expect(query).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith({ origin: origin ?? undefined }, 'Socket handshake refused: origin not allowed');

    query.mockRestore();
    expect((await connectSocket(server.url, alice.cookie)).connected).toBe(true); // the app's origin gets in
  });

  // Browsers start with HTTP long-polling; the handshake is the first GET.
  it.each([
    ['another origin', 'https://evil.example'],
    ['no Origin', undefined],
  ])('refuses a polling handshake from %s with 403', async (_case, origin) => {
    const res = await from(origin, 'get', '/socket.io/?EIO=4&transport=polling');

    expect(res.status).toBe(403);
    expect(JSON.parse(res.text)).toEqual({ code: 4, message: 'Origin not allowed' });
  });

  it("accepts a polling handshake from the app's origin", async () => {
    const res = await from(allowedOrigin, 'get', '/socket.io/?EIO=4&transport=polling');

    expect(res.status).toBe(200);
    expect(res.text).toMatch(/^0\{"sid":/);
  });
});

describe('security headers (helmet)', () => {
  it('are on every response, including errors, and X-Powered-By is gone', async () => {
    const responses = [
      await request(server.httpServer).get('/api/ping'), // 200
      await request(server.httpServer).get('/api/does-not-exist'), // 404
      await from('https://evil.example', 'post', '/api/auth/login').send({}), // 403
    ];

    for (const res of responses) {
      expect(res.get('X-Content-Type-Options'), String(res.status)).toBe('nosniff');
      expect(res.get('X-Frame-Options')).toBe('SAMEORIGIN');
      expect(res.get('Referrer-Policy')).toBe('no-referrer');
      expect(res.get('X-Powered-By')).toBeUndefined();
      // The Content Security Policy belongs to the SPA (Phase 8), not to the API.
      expect(res.get('Content-Security-Policy')).toBeUndefined();
    }
  });
});
