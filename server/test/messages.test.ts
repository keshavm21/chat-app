import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_ID } from '../lib/ids.js';
import { MESSAGE_PAGE_MAX, MESSAGE_PAGE_SIZE } from '../lib/limits.js';
import { api, createChannel, generalId, postMessages, signUp, startServer, type TestServer } from './helpers.js';

// A conversation's history, a page at a time (docs/phase-3-implementation-plan.md §5).

let server: TestServer;

beforeAll(async () => {
  server = await startServer();
});

afterAll(async () => {
  await server.close();
});

type TestUser = Awaited<ReturnType<typeof signUp>>;

async function history(user: TestUser, conversationId: number, query: Record<string, string | number> = {}) {
  const res = await api(server)
    .get(`/api/conversations/${conversationId}/messages`)
    .query(query)
    .set('Cookie', user.cookie)
    .expect(200);
  return res.body.messages as { seq: number; content: string }[];
}

const seqs = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe('GET /api/conversations/:id/messages', () => {
  it('answers 404 to anyone who is not a member, whether or not the conversation exists', async () => {
    const alice = await signUp(server);
    const bob = await signUp(server);
    const news = await createChannel(server, alice, { name: 'news' });
    await postMessages(news.id, alice.user.id, 1);

    for (const id of [news.id, MAX_ID, 'abc', '0', String(MAX_ID + 1)]) {
      const res = await api(server).get(`/api/conversations/${id}/messages`).set('Cookie', bob.cookie);
      expect(res.status, String(id)).toBe(404);
      expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Conversation not found.' } });
    }
  });

  it('returns an empty page for a conversation without messages', async () => {
    const alice = await signUp(server);

    expect(await history(alice, await generalId())).toEqual([]);
  });

  it("returns the conversation's messages oldest first by seq, in the camelCase REST shape, and no others", async () => {
    const alice = await signUp(server);
    const general = await generalId();
    const news = await createChannel(server, alice, { name: 'news' });
    await postMessages(general, alice.user.id, 3);
    await postMessages(news.id, alice.user.id, 2);

    const messages = await history(alice, general);

    expect(messages.map((m) => m.seq)).toEqual([1, 2, 3]);
    for (const message of messages) {
      expect(message).toEqual({
        id: expect.any(Number),
        conversationId: general,
        seq: expect.any(Number),
        userId: alice.user.id,
        username: alice.username,
        content: `message ${message.seq}`,
        createdAt: expect.any(String),
      });
    }
  });

  it(`returns exactly one page of ${MESSAGE_PAGE_SIZE}: its first message has seq 1, so there is nothing older`, async () => {
    const alice = await signUp(server);
    const general = await generalId();
    await postMessages(general, alice.user.id, MESSAGE_PAGE_SIZE);

    expect((await history(alice, general)).map((m) => m.seq)).toEqual(seqs(1, MESSAGE_PAGE_SIZE));
    expect(await history(alice, general, { before: 1 })).toEqual([]);
  });

  it('pages back through older messages with before', async () => {
    const alice = await signUp(server);
    const general = await generalId();
    await postMessages(general, alice.user.id, 120);

    expect((await history(alice, general)).map((m) => m.seq)).toEqual(seqs(71, 120));
    expect((await history(alice, general, { before: 71 })).map((m) => m.seq)).toEqual(seqs(21, 70));
    expect((await history(alice, general, { before: 21 })).map((m) => m.seq)).toEqual(seqs(1, 20));
    expect(await history(alice, general, { before: 1 })).toEqual([]);
    // A before past the end is the latest page.
    expect((await history(alice, general, { before: MAX_ID })).map((m) => m.seq)).toEqual(seqs(71, 120));
  });

  it(`takes a limit of 1–${MESSAGE_PAGE_MAX}`, async () => {
    const alice = await signUp(server);
    const general = await generalId();
    await postMessages(general, alice.user.id, 120);

    expect((await history(alice, general, { limit: 1 })).map((m) => m.seq)).toEqual([120]);
    expect((await history(alice, general, { limit: 10, before: 50 })).map((m) => m.seq)).toEqual(seqs(40, 49));
    expect(await history(alice, general, { limit: MESSAGE_PAGE_MAX })).toHaveLength(MESSAGE_PAGE_MAX);
  });

  it.each([
    ['limit=0'],
    [`limit=${MESSAGE_PAGE_MAX + 1}`],
    ['limit=abc'],
    ['limit=1.5'],
    ['before=0'],
    ['before=-1'],
    ['before=abc'],
    [`before=${MAX_ID + 1}`],
    ['before=1&before=2'],
  ])('answers 400 for %s', async (query) => {
    const alice = await signUp(server);

    const res = await api(server)
      .get(`/api/conversations/${await generalId()}/messages?${query}`)
      .set('Cookie', alice.cookie);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});
