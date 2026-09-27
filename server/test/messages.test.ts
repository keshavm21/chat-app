import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import pool from '../db/connection.js';
import { signUp, startServer, type TestServer } from './helpers.js';

let server: TestServer;

beforeAll(async () => {
  server = await startServer();
});

afterAll(async () => {
  await server.close();
});

describe('GET /api/messages', () => {
  it('returns 401 without a token', async () => {
    const res = await request(server.httpServer).get('/api/messages');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Access denied. No token provided.' });
  });

  it('returns an empty list when there are no messages', async () => {
    const user = await signUp(server);

    const res = await request(server.httpServer)
      .get('/api/messages')
      .set('Authorization', `Bearer ${user.token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ messages: [] });
  });

  it('returns messages oldest first, in the camelCase REST shape', async () => {
    const user = await signUp(server);
    // Inserted out of order, with explicit timestamps, so ordering is deterministic.
    await pool.query(
      `INSERT INTO messages (user_id, username, content, created_at) VALUES
         ($1, $2, 'second', '2026-01-01 10:00:02'),
         ($1, $2, 'first',  '2026-01-01 10:00:01'),
         ($1, $2, 'third',  '2026-01-01 10:00:03')`,
      [user.user.id, user.username],
    );

    const res = await request(server.httpServer)
      .get('/api/messages')
      .set('Authorization', `Bearer ${user.token}`);

    expect(res.status).toBe(200);
    expect(res.body.messages.map((m: { content: string }) => m.content)).toEqual(['first', 'second', 'third']);
    for (const message of res.body.messages) {
      expect(message).toEqual({
        id: expect.any(Number),
        userId: user.user.id,
        username: user.username,
        content: expect.any(String),
        createdAt: expect.any(String),
      });
    }
  });
});
