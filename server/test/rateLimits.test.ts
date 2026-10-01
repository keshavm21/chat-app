import { afterEach, describe, expect, it } from 'vitest';
import pool from '../db/connection.js';
import { RATE_LIMITS } from '../lib/limits.js';
import { api, signUp, startServer, type TestServer } from './helpers.js';

// The login and signup limits (audit §7.1), and the user search and channel creation limits. Each test starts its
// own server, so its counters start at zero; most use the real limits from lib/limits.ts.

let server: TestServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

const RATE_LIMITED = { error: { code: 'RATE_LIMITED', message: 'Too many attempts. Please try again later.' } };

function login(email: string, password: string) {
  return api(server!).post('/api/auth/login').send({ email, password });
}

/** Retry-After, in seconds: present, and within the limit's window. */
function expectRetryAfter(res: { get(header: string): string | undefined }, windowMs: number) {
  const seconds = Number(res.get('Retry-After'));
  expect(seconds).toBeGreaterThan(0);
  expect(seconds).toBeLessThanOrEqual(windowMs / 1000);
}

describe('the login limit', () => {
  const { limit, windowMs } = RATE_LIMITS.login;

  it(`answers the failed login after the first ${limit} for one IP and email with 429; successful logins do not count`, async () => {
    server = await startServer({ rateLimits: RATE_LIMITS });
    const alice = await signUp(server);

    for (let failure = 1; failure <= limit; failure += 1) {
      expect((await login(alice.email, 'wrong-password')).status, `failure ${failure}`).toBe(401);
      // A success in between does not use up an attempt.
      if (failure < limit) expect((await login(alice.email, alice.password)).status).toBe(200);
    }
    const limited = await login(alice.email, 'wrong-password');

    expect(limited.status).toBe(429);
    expect(limited.body).toEqual(RATE_LIMITED);
    expectRetryAfter(limited, windowMs);
    // From now on, even the right password: otherwise guessing could simply go on.
    expect((await login(alice.email, alice.password)).status).toBe(429);
    // The email is normalized as login does, so its case and spaces do not reset the count.
    expect((await login(` ${alice.email.toUpperCase()} `, 'wrong-password')).status).toBe(429);
  });

  it('counts each email separately: another account on the same IP still gets in', async () => {
    server = await startServer({ rateLimits: RATE_LIMITS });
    const alice = await signUp(server);
    const bob = await signUp(server);

    for (let attempt = 0; attempt <= limit; attempt += 1) await login(alice.email, 'wrong-password');
    expect((await login(alice.email, alice.password)).status).toBe(429);

    expect((await login(bob.email, 'wrong-password')).status).toBe(401);
    expect((await login(bob.email, bob.password)).status).toBe(200);
  });
});

describe('the signup limit', () => {
  const { limit, windowMs } = RATE_LIMITS.signup;

  it(`answers signup number ${limit + 1} from one IP with 429`, async () => {
    server = await startServer({ rateLimits: RATE_LIMITS });
    for (let i = 0; i < limit; i += 1) await signUp(server); // each expects 201

    const limited = await api(server)
      .post('/api/auth/signup')
      .send({ username: 'one_too_many', email: 'one_too_many@example.test', password: 'password123' });

    expect(limited.status).toBe(429);
    expect(limited.body).toEqual(RATE_LIMITED);
    expectRetryAfter(limited, windowMs);
    const { rows } = await pool.query('SELECT count(*)::int AS count FROM users');
    expect(rows[0].count).toBe(limit);
  });
});

describe('the user search limit', () => {
  const { limit, windowMs } = RATE_LIMITS.userSearch;
  const search = (user: { cookie: string }) => api(server!).get('/api/users').query({ q: 'a' }).set('Cookie', user.cookie);

  it(`answers search number ${limit + 1} by one user with 429; another user on the same IP still gets answers`, async () => {
    server = await startServer({ rateLimits: RATE_LIMITS });
    const alice = await signUp(server);
    const bob = await signUp(server);

    for (let i = 1; i <= limit; i += 1) expect((await search(alice)).status, `search ${i}`).toBe(200);
    const limited = await search(alice);

    expect(limited.status).toBe(429);
    expect(limited.body).toEqual(RATE_LIMITED);
    expectRetryAfter(limited, windowMs);
    expect((await search(bob)).status).toBe(200);
  });

  it('counts each IP separately: visitors sharing one account (the demo) do not share one budget', async () => {
    server = await startServer({ rateLimits: { ...RATE_LIMITS, userSearch: { limit: 2, windowMs: 60_000 } }, trustProxy: 1 });
    const demo = await signUp(server);
    const searchFrom = (ip: string) => search(demo).set('X-Forwarded-For', ip);

    expect((await searchFrom('203.0.113.1')).status).toBe(200);
    expect((await searchFrom('203.0.113.1')).status).toBe(200);
    expect((await searchFrom('203.0.113.1')).status).toBe(429);
    expect((await searchFrom('203.0.113.2')).status).toBe(200);
  });
});

describe('the channel creation limit', () => {
  const { limit, windowMs } = RATE_LIMITS.channelCreation;
  const create = (user: { cookie: string }, name: string) =>
    api(server!).post('/api/channels').set('Cookie', user.cookie).send({ name });

  it(`answers channel number ${limit + 1} created by one user with 429; failed attempts and other users do not count`, async () => {
    server = await startServer({ rateLimits: RATE_LIMITS });
    const alice = await signUp(server);
    const bob = await signUp(server);

    for (let i = 1; i <= limit; i += 1) {
      expect((await create(alice, `channel-${i}`)).status, `channel ${i}`).toBe(201);
      if (i === 1) expect((await create(alice, 'channel-1')).status).toBe(409); // a taken name: not counted
    }
    const limited = await create(alice, 'one-too-many');

    expect(limited.status).toBe(429);
    expect(limited.body).toEqual(RATE_LIMITED);
    expectRetryAfter(limited, windowMs);
    expect((await create(bob, 'bobs-channel')).status).toBe(201);
    const { rows } = await pool.query(`SELECT count(*)::int AS count FROM conversations WHERE name <> 'general'`);
    expect(rows[0].count).toBe(limit + 1);
  });
});

describe('trust proxy', () => {
  // Two signup attempts per IP. Every attempt counts, even an invalid one (400).
  const LOW = { ...RATE_LIMITS, signup: { limit: 2, windowMs: 60_000 } };
  const signupFrom = (forwardedFor: string) =>
    api(server!).post('/api/auth/signup').set('X-Forwarded-For', forwardedFor).send({});

  it('with TRUST_PROXY=0, ignores X-Forwarded-For: a client cannot claim new IPs to dodge the limit', async () => {
    server = await startServer({ rateLimits: LOW, trustProxy: 0 });

    expect((await signupFrom('203.0.113.1')).status).toBe(400);
    expect((await signupFrom('203.0.113.2')).status).toBe(400);
    expect((await signupFrom('203.0.113.3')).status).toBe(429); // all three are the socket's IP
  });

  it('with TRUST_PROXY=1, takes the client IP that the one proxy appended to X-Forwarded-For', async () => {
    server = await startServer({ rateLimits: LOW, trustProxy: 1 });

    expect((await signupFrom('203.0.113.1')).status).toBe(400);
    expect((await signupFrom('203.0.113.1')).status).toBe(400);
    expect((await signupFrom('203.0.113.1')).status).toBe(429);
    expect((await signupFrom('203.0.113.2')).status).toBe(400); // another client
    // Only the last entry, added by the trusted proxy, counts: what a client writes before it does not.
    expect((await signupFrom('198.51.100.9, 203.0.113.2')).status).toBe(400);
    expect((await signupFrom('198.51.100.10, 203.0.113.2')).status).toBe(429);
  });

  // Render's chain, from its logs at the release (docs/phase-3-implementation-plan.md §8):
  // Cloudflare appends the client's IP, Render's load balancer appends Cloudflare's, and a
  // proxy on the instance appends the balancer's and connects from loopback. Both
  // Cloudflare and the balancer vary from request to request.
  it("with TRUST_PROXY=3, as on Render, takes the IP Cloudflare saw, whichever edge and balancer carried it", async () => {
    server = await startServer({ rateLimits: LOW, trustProxy: 3 });
    const viaRender = (client: string, cloudflare: string, balancer: string) => signupFrom(`${client}, ${cloudflare}, ${balancer}`);

    expect((await viaRender('203.0.113.1', '172.69.129.131', '10.24.227.144')).status).toBe(400);
    expect((await viaRender('203.0.113.1', '172.71.195.71', '10.28.148.188')).status).toBe(400);
    expect((await viaRender('203.0.113.1', '162.158.54.41', '10.24.227.144')).status).toBe(429);
    expect((await viaRender('203.0.113.2', '172.69.129.131', '10.24.227.144')).status).toBe(400); // another client
    // A client that writes its own X-Forwarded-For is still counted by its real IP.
    expect((await viaRender('198.51.100.9, 203.0.113.2', '162.158.54.41', '10.24.227.144')).status).toBe(400);
    expect((await viaRender('198.51.100.10, 203.0.113.2', '172.71.195.71', '10.28.148.188')).status).toBe(429);
  });

  it('with TRUST_PROXY=1 behind such a chain, would count the load balancer, not the client (the release found this)', async () => {
    server = await startServer({ rateLimits: LOW, trustProxy: 1 });

    // Two different clients through the same balancer share one count...
    expect((await signupFrom('203.0.113.1, 172.69.129.131, 10.24.227.144')).status).toBe(400);
    expect((await signupFrom('203.0.113.2, 172.69.129.131, 10.24.227.144')).status).toBe(400);
    expect((await signupFrom('203.0.113.3, 172.69.129.131, 10.24.227.144')).status).toBe(429);
    // ...while one client through another balancer starts afresh.
    expect((await signupFrom('203.0.113.1, 172.71.195.71, 10.28.148.188')).status).toBe(400);
  });
});
