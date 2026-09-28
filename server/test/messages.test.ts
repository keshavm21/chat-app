import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pool from '../db/connection.js';
import { api, signUp, startServer, type TestServer } from './helpers.js';

let server: TestServer;

beforeAll(async () => {
  server = await startServer();
});

afterAll(async () => {
  await server.close();
});

describe('GET /api/messages', () => {
  it('returns 401 without a valid session', async () => {
    for (const res of [
      await api(server).get('/api/messages'),
      await api(server).get('/api/messages').set('Cookie', 'relay_session=unknown-token'),
    ]) {
      expect(res.status).toBe(401);
      expect(res.body).toEqual({
        error: { code: 'UNAUTHENTICATED', message: 'Your session has expired. Please log in again.' },
      });
    }
  });

  it('returns an empty list when there are no messages', async () => {
    const user = await signUp(server);

    const res = await api(server)
      .get('/api/messages')
      .set('Cookie', user.cookie);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ messages: [] });
  });

  it("returns #general's messages oldest first by seq, in the camelCase REST shape", async () => {
    const user = await signUp(server);
    const { rows } = await pool.query(
      `INSERT INTO conversations (type, visibility, name) VALUES ('channel', 'public', 'random') RETURNING id`,
    );
    // Inserted out of seq order; the message in another channel is not part of the history.
    await pool.query(
      `INSERT INTO messages (conversation_id, seq, author_id, client_id, content) VALUES
         ((SELECT id FROM conversations WHERE name = 'general'), 2, $1, gen_random_uuid(), 'second'),
         ((SELECT id FROM conversations WHERE name = 'general'), 1, $1, gen_random_uuid(), 'first'),
         ((SELECT id FROM conversations WHERE name = 'general'), 3, $1, gen_random_uuid(), 'third'),
         ($2, 1, $1, gen_random_uuid(), 'elsewhere')`,
      [user.user.id, rows[0].id],
    );

    const res = await api(server)
      .get('/api/messages')
      .set('Cookie', user.cookie);

    expect(res.status).toBe(200);
    expect(res.body.messages.map((m: { content: string }) => m.content)).toEqual(['first', 'second', 'third']);
    expect(res.body.messages.map((m: { seq: number }) => m.seq)).toEqual([1, 2, 3]);
    for (const message of res.body.messages) {
      expect(message).toEqual({
        id: expect.any(Number),
        seq: expect.any(Number),
        userId: user.user.id,
        username: user.username,
        content: expect.any(String),
        createdAt: expect.any(String),
      });
    }
  });
});
