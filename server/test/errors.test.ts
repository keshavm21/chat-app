import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import pool from '../db/connection.js';
import { errorHandler } from '../http/errorHandler.js';
import { logger } from '../lib/logger.js';
import { api, signUp, startServer, type TestServer } from './helpers.js';

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

describe('REST error envelope', () => {
  it('returns a JSON 404 for an unknown /api route', async () => {
    for (const res of [
      await api(server).get('/api/does-not-exist'),
      await api(server).post('/api/auth/does-not-exist').send({}),
    ]) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Route not found.' } });
    }
  });

  it('returns 400 INVALID_JSON for a malformed JSON body, without echoing the body', async () => {
    const res = await api(server)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email": "a@example.test", "password": "hunter2-SENSITIVE"');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON.' } });
    expect(res.text).not.toContain('SENSITIVE');
  });

  it('keeps the 4xx status of other body errors, such as a body that is too large', async () => {
    const res = await api(server)
      .post('/api/auth/login')
      .send({ email: 'a@example.test', password: 'x'.repeat(200_000) });

    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('returns 400 VALIDATION_ERROR with the first problem and details of all of them when signup fields are missing', async () => {
    const res = await api(server).post('/api/auth/signup').send({ email: 'a@example.test' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Username is required.',
        details: [
          { field: 'username', message: 'Username is required.' },
          { field: 'password', message: 'Password is required.' },
        ],
      },
    });
  });

  it('returns 400 VALIDATION_ERROR when login fields are blank', async () => {
    const res = await api(server).post('/api/auth/login').send({ email: '  ', password: '' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Email is required.',
        details: [
          { field: 'email', message: 'Email is required.' },
          { field: 'password', message: 'Password is required.' },
        ],
      },
    });
  });

  // A form body used to reach the route as req.body = undefined (a 400 since Phase 0,
  // a 500 before). Now only JSON gets that far (CSRF, docs/v2-design.md §6).
  it.each(['/api/auth/signup', '/api/auth/login'])('returns 415 UNSUPPORTED_MEDIA_TYPE when the body of %s is not JSON', async (path) => {
    const res = await api(server)
      .post(path)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('email=a%40example.test&password=password123');

    expect(res.status).toBe(415);
    expect(res.body).toEqual({ error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Request body must be JSON.' } });
  });

  it.each(['/api/auth/signup', '/api/auth/login'])('returns 400 VALIDATION_ERROR when the JSON body of %s is not an object', async (path) => {
    const res = await api(server).post(path).send([]);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request body must be a JSON object.',
        details: [{ field: '', message: 'Request body must be a JSON object.' }],
      },
    });
  });

  it('returns the route’s 500 message, without internal details, when the database fails', async () => {
    const dave = await signUp(server);
    const logged = vi.spyOn(logger, 'error');
    const query = pool.query.bind(pool);
    vi.spyOn(pool, 'query')
      .mockImplementationOnce(query as never) // the session lookup (requireSession) succeeds
      .mockRejectedValueOnce(new Error('db exploded at 10.0.0.5'));

    const res = await api(server).get('/api/messages').set('Cookie', dave.cookie);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch messages.' } });
    expect(res.text).not.toContain('db exploded');
    // The real cause goes to the server log instead.
    expect(logged).toHaveBeenCalledWith(
      { err: expect.objectContaining({ message: 'db exploded at 10.0.0.5' }) },
      'Error fetching messages',
    );
  });
});

describe('errorHandler', () => {
  it('turns an unexpected error into a generic 500 with no stack or message, and logs it', async () => {
    const logged = vi.spyOn(logger, 'error');
    const app = express();
    app.get('/boom', () => {
      throw new Error('secret internal detail');
    });
    app.use(errorHandler);

    const res = await request(app).get('/boom');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error.' } });
    expect(res.text).not.toContain('secret internal detail');
    expect(res.text).not.toMatch(/\bat \S+:\d+/); // no stack frames
    expect(logged).toHaveBeenCalledOnce();
  });
});
