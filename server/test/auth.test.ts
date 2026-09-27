import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import pool from '../db/connection.js';
import { logger } from '../lib/logger.js';
import { sessionCookieOf, signUp, startServer, type TestServer } from './helpers.js';

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

const alice = { username: 'alice', email: 'alice@example.test', password: 'password123' };

async function userCount() {
  const { rows } = await pool.query('SELECT count(*)::int AS count FROM users');
  return rows[0].count;
}

describe('POST /api/auth/signup', () => {
  it('creates the user, returns it without a token and stores a bcrypt hash of the password', async () => {
    const res = await request(server.httpServer).post('/api/auth/signup').send(alice);

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ user: { id: expect.any(Number), username: 'alice', email: 'alice@example.test' } });

    const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [res.body.user.id]);
    expect(rows[0].password_hash).not.toBe(alice.password);
    expect(rows[0].password_hash).toMatch(/^\$2[aby]\$10\$/);
    expect(await bcrypt.compare(alice.password, rows[0].password_hash)).toBe(true);
  });

  it('adds the new user to #general as a member who has already read its earlier messages', async () => {
    await pool.query(`UPDATE conversations SET last_seq = 7 WHERE name = 'general'`);

    const res = await request(server.httpServer).post('/api/auth/signup').send(alice).expect(201);

    const { rows } = await pool.query(
      `SELECT c.name, m.role, m.last_read_seq
       FROM conversation_members m JOIN conversations c ON c.id = m.conversation_id
       WHERE m.user_id = $1`,
      [res.body.user.id],
    );
    expect(rows).toEqual([{ name: 'general', role: 'member', last_read_seq: 7 }]);
  });

  it('creates neither the user nor the membership, and sets no cookie, if either insert fails', async () => {
    const logged = vi.spyOn(logger, 'error');
    // Without #general, adding the membership fails after the user was inserted.
    await pool.query(`DELETE FROM conversations WHERE name = 'general'`);

    const res = await request(server.httpServer).post('/api/auth/signup').send(alice);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Server error during signup.' } });
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(await userCount()).toBe(0);
    expect(logged).toHaveBeenCalledOnce();
  });

  it('rejects a duplicate email with 409', async () => {
    await request(server.httpServer).post('/api/auth/signup').send(alice).expect(201);

    const res = await request(server.httpServer)
      .post('/api/auth/signup')
      .send({ ...alice, username: 'someone_else' });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: { code: 'CONFLICT', message: 'Email or username is already taken.' } });
    expect(await userCount()).toBe(1);
  });

  it('rejects a duplicate username with 409', async () => {
    await request(server.httpServer).post('/api/auth/signup').send(alice).expect(201);

    const res = await request(server.httpServer)
      .post('/api/auth/signup')
      .send({ ...alice, email: 'other@example.test' });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: { code: 'CONFLICT', message: 'Email or username is already taken.' } });
    expect(await userCount()).toBe(1);
  });

  // Audit §4.6: two signups can both pass the pre-check before either inserts; the
  // database's unique constraint then rejects the second (Postgres error 23505).
  it.each([
    ['email', { ...alice, username: 'someone_else' }],
    ['username', { ...alice, email: 'other@example.test' }],
  ])('returns 409, not 500, when the unique constraint catches a duplicate %s the pre-check missed', async (_field, duplicate) => {
    await request(server.httpServer).post('/api/auth/signup').send(alice).expect(201);
    const logged = vi.spyOn(logger, 'error');
    // Simulate losing the race: the pre-check SELECT sees no existing user.
    vi.spyOn(pool, 'query').mockResolvedValueOnce({ rows: [] } as never);

    const res = await request(server.httpServer).post('/api/auth/signup').send(duplicate);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: { code: 'CONFLICT', message: 'Email or username is already taken.' } });
    expect(await userCount()).toBe(1);
    expect(logged).not.toHaveBeenCalled(); // an expected conflict, not a server error
  });

  it('handles concurrent signups with the same email: exactly one 201, the rest 409, never 500', async () => {
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        request(server.httpServer)
          .post('/api/auth/signup')
          .send({ username: `racer${n}`, email: 'race@example.test', password: 'password123' }),
      ),
    );

    const statuses = results.map((res) => res.status).sort();
    expect(statuses).toEqual([201, 409, 409, 409, 409]);
    expect(await userCount()).toBe(1);
  });

  const usernameRule = 'Username must be 3–32 characters: letters, digits or underscores.';

  // Audit §4.7: a username over 50 characters used to reach the database and return 500.
  it.each([
    ['too short', 'ab'],
    ['33 characters', 'a'.repeat(33)],
    ['51 characters, audit §4.7', 'a'.repeat(51)],
    ['with a space', 'has space'],
    ['with a hyphen', 'has-hyphen'],
    ['with a non-ASCII letter', 'élise'],
  ])('rejects an invalid username (%s) with 400 VALIDATION_ERROR', async (_case, username) => {
    const res = await request(server.httpServer).post('/api/auth/signup').send({ ...alice, username });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: { code: 'VALIDATION_ERROR', message: usernameRule, details: [{ field: 'username', message: usernameRule }] },
    });
    expect(await userCount()).toBe(0);
  });

  it.each(['abc', 'x'.repeat(32), 'under_score_42'])('accepts the username %s', async (username) => {
    const res = await request(server.httpServer).post('/api/auth/signup').send({ ...alice, username });

    expect(res.status).toBe(201);
    expect(res.body.user.username).toBe(username);
  });

  it('stores the username trimmed and lowercased, so another case of it is a duplicate', async () => {
    const res = await request(server.httpServer).post('/api/auth/signup').send({ ...alice, username: ' Alice_1 ' });

    expect(res.status).toBe(201);
    expect(res.body.user.username).toBe('alice_1');
    // The display name keeps the username as typed (trimmed).
    const { rows } = await pool.query('SELECT username, display_name FROM users');
    expect(rows).toEqual([{ username: 'alice_1', display_name: 'Alice_1' }]);

    const duplicate = await request(server.httpServer)
      .post('/api/auth/signup')
      .send({ ...alice, username: 'alice_1', email: 'other@example.test' });

    expect(duplicate.status).toBe(409);
    expect(await userCount()).toBe(1);
  });

  it('stores the email trimmed and lowercased, so another case of it is a duplicate', async () => {
    const res = await request(server.httpServer)
      .post('/api/auth/signup')
      .send({ ...alice, email: ' Alice@Example.test ' });

    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe('alice@example.test');

    const duplicate = await request(server.httpServer)
      .post('/api/auth/signup')
      .send({ ...alice, username: 'someone_else', email: 'ALICE@EXAMPLE.TEST' });

    expect(duplicate.status).toBe(409);
    expect(await userCount()).toBe(1);
  });

  it.each([
    ['not an address', 'not-an-email', 'Email must be a valid email address.'],
    ['missing its domain', 'alice@', 'Email must be a valid email address.'],
    ['101 characters', `${'a'.repeat(88)}@example.test`, 'Email must be at most 100 characters.'],
  ])('rejects an invalid email (%s) with 400 VALIDATION_ERROR', async (_case, email, message) => {
    const res = await request(server.httpServer).post('/api/auth/signup').send({ ...alice, email });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { code: 'VALIDATION_ERROR', message, details: [{ field: 'email', message }] } });
    expect(await userCount()).toBe(0);
  });

  it('accepts an email of exactly 100 characters', async () => {
    const email = `${'a'.repeat(87)}@example.test`;

    const res = await request(server.httpServer).post('/api/auth/signup').send({ ...alice, email });

    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe(email);
  });
});

describe('POST /api/auth/login', () => {
  it('returns the user without a token, and starts a session, for correct credentials', async () => {
    const user = await signUp(server);

    const res = await request(server.httpServer)
      .post('/api/auth/login')
      .send({ email: user.email, password: user.password });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ user: user.user });
    const me = await request(server.httpServer).get('/api/auth/me').set('Cookie', sessionCookieOf(res));
    expect(me.body).toEqual({ user: user.user });
  });

  it('responds identically to an unknown email and a wrong password', async () => {
    const user = await signUp(server);

    const unknownEmail = await request(server.httpServer)
      .post('/api/auth/login')
      .send({ email: 'nobody@example.test', password: user.password });
    const wrongPassword = await request(server.httpServer)
      .post('/api/auth/login')
      .send({ email: user.email, password: 'wrong-password' });

    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.body).toEqual({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' } });
    expect(wrongPassword.body).toEqual(unknownEmail.body);
    expect(unknownEmail.headers['set-cookie']).toBeUndefined();
    expect(wrongPassword.headers['set-cookie']).toBeUndefined();
  });

  it('normalizes the email the same way as signup before the lookup', async () => {
    const signup = await request(server.httpServer)
      .post('/api/auth/signup')
      .send({ ...alice, email: 'Alice@Example.test' })
      .expect(201);

    const res = await request(server.httpServer)
      .post('/api/auth/login')
      .send({ email: ' ALICE@example.test ', password: alice.password });

    expect(res.status).toBe(200);
    expect(res.body.user).toEqual(signup.body.user);
  });
});
