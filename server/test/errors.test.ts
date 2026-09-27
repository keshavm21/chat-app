import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import pool from '../db/connection.js';
import { errorHandler } from '../http/errorHandler.js';
import { startServer, type TestServer } from './helpers.js';

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
      await request(server.httpServer).get('/api/does-not-exist'),
      await request(server.httpServer).post('/api/auth/does-not-exist').send({}),
    ]) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Route not found.' } });
    }
  });

  it('returns 400 INVALID_JSON for a malformed JSON body, without echoing the body', async () => {
    const res = await request(server.httpServer)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email": "a@example.test", "password": "hunter2-SENSITIVE"');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON.' } });
    expect(res.text).not.toContain('SENSITIVE');
  });

  it('keeps the 4xx status of other body errors, such as a body that is too large', async () => {
    const res = await request(server.httpServer)
      .post('/api/auth/login')
      .send({ email: 'a@example.test', password: 'x'.repeat(200_000) });

    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('returns 400 VALIDATION_ERROR when signup fields are missing', async () => {
    const res = await request(server.httpServer).post('/api/auth/signup').send({ email: 'a@example.test' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { code: 'VALIDATION_ERROR', message: 'All fields are required.' } });
  });

  it('returns 403 INVALID_TOKEN for an invalid token', async () => {
    const res = await request(server.httpServer)
      .get('/api/messages')
      .set('Authorization', 'Bearer not-a-valid-token');

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: { code: 'INVALID_TOKEN', message: 'Invalid or expired token.' } });
  });

  it('returns the route’s 500 message, without internal details, when the database fails', async () => {
    const { token } = (
      await request(server.httpServer)
        .post('/api/auth/signup')
        .send({ username: 'dave', email: 'dave@example.test', password: 'password123' })
    ).body;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(pool, 'query').mockRejectedValueOnce(new Error('db exploded at 10.0.0.5'));

    const res = await request(server.httpServer).get('/api/messages').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch messages.' } });
    expect(res.text).not.toContain('db exploded');
  });
});

describe('errorHandler', () => {
  it('turns an unexpected error into a generic 500 with no stack or message, and logs it', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
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
