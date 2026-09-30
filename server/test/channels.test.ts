import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pool from '../db/connection.js';
import { CHANNEL_LIST_LIMIT, CHANNEL_TOPIC_MAX_LENGTH } from '../lib/limits.js';
import { api, createChannel, generalId, signUp, startServer, type TestServer } from './helpers.js';

// Browsing and creating channels (docs/phase-3-implementation-plan.md §5).

let server: TestServer;

beforeAll(async () => {
  server = await startServer();
});

afterAll(async () => {
  await server.close();
});

describe('GET /api/channels', () => {
  it('lists public channels by name, with whether I am a member, and never private channels or DMs', async () => {
    const alice = await signUp(server);
    const bob = await signUp(server);
    const zeta = await createChannel(server, alice, { name: 'zeta', topic: 'The last one' });
    const alpha = await createChannel(server, alice, { name: 'alpha' });
    await createChannel(server, alice, { name: 'secret', visibility: 'private' });
    await api(server).post('/api/dms').set('Cookie', alice.cookie).send({ userId: bob.user.id }).expect(201);

    const res = await api(server).get('/api/channels').set('Cookie', bob.cookie);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      channels: [
        { id: alpha.id, name: 'alpha', topic: null, isMember: false },
        { id: await generalId(), name: 'general', topic: null, isMember: true },
        { id: zeta.id, name: 'zeta', topic: 'The last one', isMember: false },
      ],
    });
  });

  it('filters by name prefix, ignoring case and surrounding spaces, and takes q literally', async () => {
    const alice = await signUp(server);
    for (const name of ['alpha', 'alps', 'beta']) await createChannel(server, alice, { name });
    const names = async (q: string) => {
      const res = await api(server).get('/api/channels').query({ q }).set('Cookie', alice.cookie).expect(200);
      return res.body.channels.map((channel: { name: string }) => channel.name);
    };

    expect(await names('al')).toEqual(['alpha', 'alps']);
    expect(await names(' ALP ')).toEqual(['alpha', 'alps']);
    expect(await names('alpha')).toEqual(['alpha']);
    expect(await names('')).toEqual(['alpha', 'alps', 'beta', 'general']);
    expect(await names('x')).toEqual([]);
    // Not a LIKE pattern: an underscore is not a wildcard.
    expect(await names('_')).toEqual([]);
    expect(await names('a_')).toEqual([]);
  });

  it(`lists at most ${CHANNEL_LIST_LIMIT} channels`, async () => {
    const alice = await signUp(server);
    await pool.query(
      `INSERT INTO conversations (type, visibility, name)
       SELECT 'channel', 'public', 'channel-' || lpad(s::text, 3, '0') FROM generate_series(1, $1) AS s`,
      [CHANNEL_LIST_LIMIT + 10],
    );

    const res = await api(server).get('/api/channels').set('Cookie', alice.cookie).expect(200);

    expect(res.body.channels).toHaveLength(CHANNEL_LIST_LIMIT);
    expect(res.body.channels[0].name).toBe('channel-001');
  });

  it('answers 400 for a repeated q, one over 100 characters, or one no channel name could start with', async () => {
    const alice = await signUp(server);

    for (const url of [
      '/api/channels?q=a&q=b',
      `/api/channels?q=${'x'.repeat(101)}`,
      '/api/channels?q=%25',
      '/api/channels?q=a%00',
      '/api/channels?q=has%20space',
    ]) {
      const res = await api(server).get(url).set('Cookie', alice.cookie);
      expect(res.status, url).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
  });
});

describe('POST /api/channels', () => {
  it('creates a public channel with its creator as owner and first member, and answers 201 with its summary', async () => {
    const alice = await signUp(server);

    const res = await api(server)
      .post('/api/channels')
      .set('Cookie', alice.cookie)
      .send({ name: 'random', topic: 'Anything goes' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      conversation: {
        id: expect.any(Number),
        type: 'channel',
        visibility: 'public',
        name: 'random',
        topic: 'Anything goes',
        role: 'owner',
        lastSeq: 0,
        lastReadSeq: 0,
        unreadCount: 0,
        lastMessageAt: null,
        lastActivityAt: expect.any(String),
      },
    });
    const { rows } = await pool.query(
      `SELECT c.type, c.visibility, c.name, c.topic, c.created_by, m.user_id, m.role
       FROM conversations c JOIN conversation_members m ON m.conversation_id = c.id
       WHERE c.id = $1`,
      [res.body.conversation.id],
    );
    expect(rows).toEqual([
      { type: 'channel', visibility: 'public', name: 'random', topic: 'Anything goes', created_by: alice.user.id, user_id: alice.user.id, role: 'owner' },
    ]);
  });

  it('trims and lowercases the name', async () => {
    const alice = await signUp(server);

    const channel = await createChannel(server, alice, { name: '  Team-Chat  ' });

    expect(channel.name).toBe('team-chat');
  });

  it.each([
    [{}],
    [{ name: '' }],
    [{ name: '   ' }],
    [{ name: 'has space' }],
    [{ name: 'under_score' }],
    [{ name: '#general' }],
    [{ name: 'x'.repeat(41) }],
    [{ name: 42 }],
    [{ name: 'ok', topic: 42 }],
    [{ name: 'ok', topic: 'x'.repeat(CHANNEL_TOPIC_MAX_LENGTH + 1) }],
    [{ name: 'ok', topic: 'nul \u0000 inside' }],
    [{ name: 'ok', visibility: 'secret' }],
  ])('answers 400 for %j and creates nothing', async (body) => {
    const alice = await signUp(server);

    const res = await api(server).post('/api/channels').set('Cookie', alice.cookie).send(body);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    const { rows } = await pool.query('SELECT count(*)::int AS count FROM conversations');
    expect(rows[0].count).toBe(1); // #general
  });

  it(`accepts a topic of up to ${CHANNEL_TOPIC_MAX_LENGTH} characters, trimmed; a blank topic is none`, async () => {
    const alice = await signUp(server);

    expect((await createChannel(server, alice, { name: 'long', topic: '😀'.repeat(CHANNEL_TOPIC_MAX_LENGTH) })).topic).toBe(
      '😀'.repeat(CHANNEL_TOPIC_MAX_LENGTH),
    );
    expect((await createChannel(server, alice, { name: 'padded', topic: '  hi  ' })).topic).toBe('hi');
    expect((await createChannel(server, alice, { name: 'blank', topic: '   ' })).topic).toBeNull();
    expect((await createChannel(server, alice, { name: 'null', topic: null })).topic).toBeNull();
  });

  it('answers 409 for a public channel whose name another public channel has, whatever its case', async () => {
    const alice = await signUp(server);
    await createChannel(server, alice, { name: 'taken' });

    for (const name of ['taken', 'TAKEN', 'general']) {
      const res = await api(server).post('/api/channels').set('Cookie', alice.cookie).send({ name });
      expect(res.status, name).toBe(409);
      expect(res.body).toEqual({ error: { code: 'CONFLICT', message: 'A channel with that name already exists.' } });
    }
  });

  it("never reveals a private channel's name: public and private channels may share it", async () => {
    const alice = await signUp(server);
    const bob = await signUp(server);
    const hidden = await createChannel(server, alice, { name: 'hidden', visibility: 'private' });

    // Bob cannot learn that Alice's private #hidden exists by trying its name.
    const mine = await createChannel(server, bob, { name: 'hidden' });
    const alsoPrivate = await createChannel(server, bob, { name: 'hidden', visibility: 'private' });

    expect(new Set([hidden.id, mine.id, alsoPrivate.id]).size).toBe(3);
    const listed = await api(server).get('/api/channels').query({ q: 'hidden' }).set('Cookie', alice.cookie).expect(200);
    expect(listed.body.channels).toEqual([{ id: mine.id, name: 'hidden', topic: null, isMember: false }]);
  });

  it('creates a private channel when asked', async () => {
    const alice = await signUp(server);

    const channel = await createChannel(server, alice, { name: 'plans', visibility: 'private' });

    expect(channel).toMatchObject({ type: 'channel', visibility: 'private', name: 'plans', role: 'owner' });
  });
});
