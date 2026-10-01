import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pool from '../db/connection.js';
import { DEMO_ACCOUNT, seedDemo } from '../scripts/seedDemo.js';
import { api, sessionCookieOf, startServer, type TestServer } from './helpers.js';

// `npm run seed:demo` (scripts/seedDemo.ts): the demo account and what a visitor finds.

let server: TestServer;

beforeAll(async () => {
  server = await startServer();
});

afterAll(async () => {
  await server.close();
});

async function logInAsDemo() {
  const res = await api(server).post('/api/auth/login').send({ email: DEMO_ACCOUNT.email, password: DEMO_ACCOUNT.password });
  expect(res.status).toBe(200);
  return sessionCookieOf(res);
}

async function counts() {
  const { rows } = await pool.query(
    `SELECT (SELECT count(*) FROM users)::int AS users,
            (SELECT count(*) FROM conversations)::int AS conversations,
            (SELECT count(*) FROM conversation_members)::int AS members,
            (SELECT count(*) FROM messages)::int AS messages`,
  );
  return rows[0];
}

describe('seedDemo', () => {
  it('creates the demo account, which can log in and finds channels, a private channel and a DM, with unread messages', async () => {
    const report = await seedDemo();

    expect(report).toEqual({ usersCreated: 5, conversationsCreated: 4, messagesCreated: 14 });
    const cookie = await logInAsDemo();
    const res = await api(server).get('/api/conversations').set('Cookie', cookie).expect(200);
    const summary = res.body.conversations.map((c: Record<string, unknown>) => [c.type, c.visibility, c.name, c.role, c.unreadCount]);
    expect(summary).toEqual(
      expect.arrayContaining([
        ['channel', 'public', 'general', 'member', 4],
        ['channel', 'public', 'random', 'member', 3],
        ['channel', 'public', 'engineering', 'member', 4],
        ['channel', 'private', 'launch-plans', 'owner', 2],
        ['dm', null, 'maya', 'member', 1],
      ]),
    );
    expect(summary).toHaveLength(5);
    // Each conversation's messages are in order, spaced out in time.
    const general = res.body.conversations.find((c: { name: string }) => c.name === 'general');
    expect(general.topic).toBe('Everyone lands here. Say hi!');
    const history = await api(server).get(`/api/conversations/${general.id}/messages`).set('Cookie', cookie).expect(200);
    expect(history.body.messages.map((m: { seq: number; username: string }) => [m.seq, m.username])).toEqual([
      [1, 'maya'],
      [2, 'sam'],
      [3, 'priya'],
      [4, 'leo'],
    ]);
    const times = history.body.messages.map((m: { createdAt: string }) => Date.parse(m.createdAt));
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('changes nothing when run again', async () => {
    await seedDemo();
    const before = await counts();
    const ids = (await pool.query('SELECT id FROM conversations ORDER BY id')).rows;

    expect(await seedDemo()).toEqual({ usersCreated: 0, conversationsCreated: 0, messagesCreated: 0 });

    expect(await counts()).toEqual(before);
    expect((await pool.query('SELECT id FROM conversations ORDER BY id')).rows).toEqual(ids);
  });

  it('adds no messages to a conversation that has some, and keeps its topic', async () => {
    const signup = await api(server)
      .post('/api/auth/signup')
      .send({ username: 'early_bird', email: 'early_bird@example.test', password: 'password123' })
      .expect(201);
    await pool.query(`UPDATE conversations SET topic = 'Ours' WHERE name = 'general'`);
    await pool.query(
      `WITH c AS (UPDATE conversations SET last_seq = 1 WHERE name = 'general' RETURNING id)
       INSERT INTO messages (conversation_id, seq, author_id, client_id, content) SELECT id, 1, $1, gen_random_uuid(), 'first!' FROM c`,
      [signup.body.user.id],
    );

    const report = await seedDemo();

    expect(report.messagesCreated).toBe(10); // everything but #general's four
    const { rows } = await pool.query(`SELECT c.topic, count(m.id)::int AS messages FROM conversations c
      JOIN messages m ON m.conversation_id = c.id WHERE c.name = 'general' GROUP BY c.topic`);
    expect(rows).toEqual([{ topic: 'Ours', messages: 1 }]);
  });

  it('refuses to run, and creates nothing, when one of its usernames belongs to someone else', async () => {
    await api(server)
      .post('/api/auth/signup')
      .send({ username: 'maya', email: 'the-real-maya@example.test', password: 'password123' })
      .expect(201);
    const before = await counts();

    await expect(seedDemo()).rejects.toThrow('The username "maya" belongs to someone else');

    expect(await counts()).toEqual(before);
  });
});
