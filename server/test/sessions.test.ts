import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'crypto';
import express from 'express';
import request from 'supertest';
import { parseSetCookie } from 'cookie';
import pool from '../db/connection.js';
import { logger } from '../lib/logger.js';
import { SESSION_MAX_AGE_MS, USER_AGENT_MAX_LENGTH } from '../lib/limits.js';
import { sessionCookieFor } from '../lib/sessions.js';
import { api, sessionCookieOf, sessionHashOf, setSessionAgo, signUp, startServer, type TestServer } from './helpers.js';

// Server-side sessions (docs/v2-design.md §6): expiry is tested by moving the
// session's timestamps in the database, never by waiting.

let server: TestServer;

beforeAll(async () => {
  server = await startServer();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await server.close();
});

const SESSION_EXPIRED = {
  error: { code: 'UNAUTHENTICATED', message: 'Your session has expired. Please log in again.' },
};

const credentials = { username: 'alice', email: 'alice@example.test', password: 'password123' };

const tokenOf = (cookie: string) => cookie.slice(cookie.indexOf('=') + 1);
const unknownSession = () => `relay_session=${randomBytes(32).toString('base64url')}`;

/** GET /api/auth/me with a session cookie (`name=value`), or with none. */
function me(cookie?: string) {
  const req = api(server).get('/api/auth/me');
  return cookie === undefined ? req : req.set('Cookie', cookie);
}

function login(user: { email: string; password: string }) {
  return api(server).post('/api/auth/login').send({ email: user.email, password: user.password });
}

function logout(cookie?: string) {
  const req = api(server).post('/api/auth/logout').send({});
  return cookie === undefined ? req : req.set('Cookie', cookie);
}

async function session(cookie: string) {
  const { rows } = await pool.query('SELECT * FROM sessions WHERE token_hash = $1', [sessionHashOf(cookie)]);
  return rows[0];
}

describe('the session cookie', () => {
  it('is set by signup and login: httpOnly, SameSite=Lax, for 30 days, and never in the body', async () => {
    const signup = await api(server).post('/api/auth/signup').send(credentials);
    const loggedIn = await login(credentials);

    for (const res of [signup, loggedIn]) {
      expect(Object.keys(res.body)).toEqual(['user']);
      const setCookies = res.get('Set-Cookie') ?? [];
      expect(setCookies).toHaveLength(1);
      expect(parseSetCookie(setCookies[0])).toEqual({
        name: 'relay_session',
        value: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), // 32 random bytes, base64url
        maxAge: SESSION_MAX_AGE_MS / 1000,
        expires: expect.any(Date),
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
      });
    }
  });

  it('is __Host-relay_session with Secure when NODE_ENV is production', async () => {
    const app = express();
    app.get('/', (_req, res) => {
      sessionCookieFor('production').set(res, 'token');
      res.end();
    });

    const res = await request(app).get('/');

    expect(parseSetCookie(res.get('Set-Cookie')![0])).toMatchObject({
      name: '__Host-relay_session',
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
    });
    expect(sessionCookieFor('development').name).toBe('relay_session');
    expect(sessionCookieFor('test').name).toBe('relay_session');
  });

  it('is stored only as the SHA-256 of its token, never as the token', async () => {
    const alice = await signUp(server);

    const row = await session(alice.cookie);
    expect(row.user_id).toBe(alice.user.id);
    expect(row.token_hash).toEqual(sessionHashOf(alice.cookie));
    const { rows } = await pool.query('SELECT s::text AS text FROM sessions s');
    expect(rows).toHaveLength(1);
    expect(rows[0].text).not.toContain(tokenOf(alice.cookie));
  });

  it(`keeps the user agent, cut to USER_AGENT_MAX_LENGTH (${USER_AGENT_MAX_LENGTH}, lib/limits.ts) characters`, async () => {
    const alice = await signUp(server);
    const long = sessionCookieOf(await login(alice).set('User-Agent', 'x'.repeat(USER_AGENT_MAX_LENGTH + 100)));
    const short = sessionCookieOf(await login(alice).set('User-Agent', 'Test Browser/1.0'));

    expect((await session(long)).user_agent).toBe('x'.repeat(USER_AGENT_MAX_LENGTH));
    expect((await session(short)).user_agent).toBe('Test Browser/1.0');
  });
});

describe('GET /api/auth/me', () => {
  it('returns the user of the session', async () => {
    const alice = await signUp(server);

    const res = await me(alice.cookie);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ user: alice.user });
  });

  it('returns 401 without a session cookie, or with an empty or unknown one', async () => {
    for (const cookie of [undefined, 'other=cookie', 'relay_session=', unknownSession()]) {
      const res = await me(cookie);

      expect(res.status, String(cookie)).toBe(401);
      expect(res.body).toEqual(SESSION_EXPIRED);
    }
  });

  it('returns 401 once the session is past expires_at', async () => {
    const alice = await signUp(server);
    await setSessionAgo(alice.cookie, 'expires_at', '1 second');

    const res = await me(alice.cookie);

    expect(res.status).toBe(401);
    expect(res.body).toEqual(SESSION_EXPIRED);
  });

  it('returns 401 once the session has not been used for over 7 days', async () => {
    const alice = await signUp(server);
    await setSessionAgo(alice.cookie, 'last_seen_at', '6 days 23 hours');
    await me(alice.cookie).expect(200);

    await setSessionAgo(alice.cookie, 'last_seen_at', '8 days');
    const res = await me(alice.cookie);

    expect(res.status).toBe(401);
    expect(res.body).toEqual(SESSION_EXPIRED);
  });

  it('moves last_seen_at when it is over an hour old, not on every request', async () => {
    const alice = await signUp(server);
    await setSessionAgo(alice.cookie, 'last_seen_at', '30 minutes');
    const recent = (await session(alice.cookie)).last_seen_at;

    await me(alice.cookie).expect(200);
    expect((await session(alice.cookie)).last_seen_at).toEqual(recent);

    await setSessionAgo(alice.cookie, 'last_seen_at', '2 hours');
    await me(alice.cookie).expect(200);
    const { rows } = await pool.query(
      `SELECT now() - last_seen_at < interval '1 minute' AS just_now FROM sessions WHERE token_hash = $1`,
      [sessionHashOf(alice.cookie)],
    );
    expect(rows[0].just_now).toBe(true);
  });

  it('returns 500, not 401, when the session lookup fails, so the client stays logged in', async () => {
    const alice = await signUp(server);
    const logged = vi.spyOn(logger, 'error');
    vi.spyOn(pool, 'query').mockRejectedValueOnce(new Error('db down'));

    const res = await me(alice.cookie);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error.' } });
    expect(logged).toHaveBeenCalledOnce();
  });
});

describe('sessions', () => {
  it('are created by every login, and each works on its own', async () => {
    const alice = await signUp(server);
    const second = sessionCookieOf(await login(alice));
    const third = sessionCookieOf(await login(alice));

    expect(new Set([alice.cookie, second, third]).size).toBe(3);
    for (const cookie of [alice.cookie, second, third]) {
      expect((await me(cookie)).body).toEqual({ user: alice.user });
    }
    const { rows } = await pool.query('SELECT count(*)::int AS count FROM sessions WHERE user_id = $1', [alice.user.id]);
    expect(rows[0].count).toBe(3);
  });

  it('never adopt a session cookie the login request already carries', async () => {
    const alice = await signUp(server);
    const planted = unknownSession();

    const res = await login(alice).set('Cookie', planted);

    expect(sessionCookieOf(res)).not.toBe(planted);
    await me(planted).expect(401);
  });

  it('end when their user is deleted', async () => {
    const alice = await signUp(server);

    await pool.query('DELETE FROM users WHERE id = $1', [alice.user.id]);

    expect((await pool.query('SELECT * FROM sessions')).rows).toEqual([]);
    await me(alice.cookie).expect(401);
  });
});

describe('POST /api/auth/logout', () => {
  it('ends only its own session, clears the cookie and returns 204', async () => {
    const alice = await signUp(server);
    const other = sessionCookieOf(await login(alice));

    const res = await logout(alice.cookie);

    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect(parseSetCookie(res.get('Set-Cookie')![0])).toEqual({
      name: 'relay_session',
      value: '',
      expires: new Date(0),
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
    });
    expect((await me(alice.cookie)).body).toEqual(SESSION_EXPIRED);
    expect((await me(other)).body).toEqual({ user: alice.user });
    expect(await session(alice.cookie)).toBeUndefined();
  });

  it('returns 204 and clears the cookie even without a valid session', async () => {
    for (const cookie of [undefined, unknownSession()]) {
      const res = await logout(cookie);

      expect(res.status).toBe(204);
      expect(parseSetCookie(res.get('Set-Cookie')![0])).toMatchObject({ name: 'relay_session', value: '' });
    }
  });
});
