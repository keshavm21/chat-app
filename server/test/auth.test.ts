import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import pool from '../db/connection.js';
import { signUp, startServer, type TestServer } from './helpers.js';

let server: TestServer;

beforeAll(async () => {
  server = await startServer();
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
  it('creates the user, returns a token and stores a bcrypt hash of the password', async () => {
    const res = await request(server.httpServer).post('/api/auth/signup').send(alice);

    expect(res.status).toBe(201);
    expect(res.body.user).toEqual({ id: expect.any(Number), username: 'alice', email: 'alice@example.test' });
    expect(jwt.verify(res.body.token, process.env.JWT_SECRET!)).toMatchObject({
      id: res.body.user.id,
      username: 'alice',
    });

    const { rows } = await pool.query('SELECT password FROM users WHERE id = $1', [res.body.user.id]);
    expect(rows[0].password).not.toBe(alice.password);
    expect(rows[0].password).toMatch(/^\$2[aby]\$10\$/);
    expect(await bcrypt.compare(alice.password, rows[0].password)).toBe(true);
  });

  it('rejects a duplicate email with 409', async () => {
    await request(server.httpServer).post('/api/auth/signup').send(alice).expect(201);

    const res = await request(server.httpServer)
      .post('/api/auth/signup')
      .send({ ...alice, username: 'someone_else' });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Email or username is already taken.' });
    expect(await userCount()).toBe(1);
  });

  it('rejects a duplicate username with 409', async () => {
    await request(server.httpServer).post('/api/auth/signup').send(alice).expect(201);

    const res = await request(server.httpServer)
      .post('/api/auth/signup')
      .send({ ...alice, email: 'other@example.test' });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Email or username is already taken.' });
    expect(await userCount()).toBe(1);
  });
});

describe('POST /api/auth/login', () => {
  it('returns the user and a valid token for correct credentials', async () => {
    const user = await signUp(server);

    const res = await request(server.httpServer)
      .post('/api/auth/login')
      .send({ email: user.email, password: user.password });

    expect(res.status).toBe(200);
    expect(res.body.user).toEqual(user.user);
    expect(jwt.verify(res.body.token, process.env.JWT_SECRET!)).toMatchObject({
      id: user.user.id,
      username: user.username,
    });
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
    expect(unknownEmail.body).toEqual({ error: 'Invalid email or password.' });
    expect(wrongPassword.body).toEqual(unknownEmail.body);
  });
});
