import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Socket } from 'socket.io-client';
import pool from '../db/connection.js';
import { MESSAGE_MAX_LENGTH } from '../lib/limits.js';
import {
  api,
  collectEvents,
  connectSocket,
  disconnectAllSockets,
  nextEvent,
  signUp,
  startServer,
  type TestServer,
} from './helpers.js';

// The send transaction's guarantees (docs/v2-design.md §5): seqs are assigned by the
// database, gapless and unique per conversation, and a failed send uses none up.

let server: TestServer;

beforeAll(async () => {
  server = await startServer();
});

afterEach(() => {
  disconnectAllSockets();
});

afterAll(async () => {
  await server.close();
});

interface Message {
  id: number;
  seq: number;
  userId: number;
  content: string;
}

async function generalLastSeq(): Promise<number> {
  const { rows } = await pool.query(`SELECT last_seq FROM conversations WHERE name = 'general'`);
  return rows[0].last_seq;
}

async function lastReadSeq(userId: number): Promise<number> {
  const { rows } = await pool.query(
    `SELECT m.last_read_seq FROM conversation_members m JOIN conversations c ON c.id = m.conversation_id
     WHERE c.name = 'general' AND m.user_id = $1`,
    [userId],
  );
  return rows[0].last_read_seq;
}

/** Sends a message and resolves with its broadcast back to the sender (after COMMIT). */
async function send(socket: Socket, content: string): Promise<Message> {
  const broadcast = nextEvent<Message>(socket, 'message');
  socket.emit('new_message', { content });
  return broadcast;
}

describe('message seq', () => {
  it('gives 20 concurrent sends from two users exactly seq 1–20, with no gaps or duplicates', async () => {
    const alice = await signUp(server);
    const bob = await signUp(server);
    const aliceSocket = await connectSocket(server.url, alice.cookie);
    const bobSocket = await connectSocket(server.url, bob.cookie);

    const broadcasts = collectEvents<Message>(aliceSocket, 'message', 20);
    // Not awaited: all 20 sends are in flight at once and contend for #general's row.
    for (let i = 1; i <= 10; i += 1) {
      aliceSocket.emit('new_message', { content: `alice ${i}` });
      bobSocket.emit('new_message', { content: `bob ${i}` });
    }
    const received = await broadcasts;

    const oneToTwenty = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(received.map((m) => m.seq).sort((a, b) => a - b)).toEqual(oneToTwenty);
    const { rows } = await pool.query('SELECT seq FROM messages ORDER BY seq');
    expect(rows.map((row) => row.seq)).toEqual(oneToTwenty);
    expect(await generalLastSeq()).toBe(20);

    // Each sender's read position is the seq of their latest message.
    for (const user of [alice, bob]) {
      const latest = Math.max(...received.filter((m) => m.userId === user.user.id).map((m) => m.seq));
      expect(await lastReadSeq(user.user.id)).toBe(latest);
    }
  });

  it('does not use up a seq when a send fails after taking one: the next message gets the next seq', async () => {
    const alice = await signUp(server);
    const carol = await signUp(server);
    const aliceSocket = await connectSocket(server.url, alice.cookie);
    const carolSocket = await connectSocket(server.url, carol.cookie);
    expect((await send(aliceSocket, 'first')).seq).toBe(1);

    // Carol's socket stays connected after her account is deleted, which also deletes
    // her membership: her send takes #general's next seq, then finds she is not a member.
    await pool.query('DELETE FROM users WHERE id = $1', [carol.user.id]);
    const rejected = nextEvent(carolSocket, 'error');
    carolSocket.emit('new_message', { content: 'from a deleted account' });
    expect(await rejected).toEqual({ message: 'You are not a member of this conversation.' });
    expect(await generalLastSeq()).toBe(1);

    expect((await send(aliceSocket, 'second')).seq).toBe(2);
    const { rows } = await pool.query('SELECT seq, content FROM messages ORDER BY seq');
    expect(rows).toEqual([
      { seq: 1, content: 'first' },
      { seq: 2, content: 'second' },
    ]);
  });

  it("sets the sender's last_read_seq to the seq of their latest message", async () => {
    const alice = await signUp(server);
    const bob = await signUp(server);
    const aliceSocket = await connectSocket(server.url, alice.cookie);
    const bobSocket = await connectSocket(server.url, bob.cookie);

    await send(aliceSocket, 'one');
    await send(aliceSocket, 'two');
    expect(await lastReadSeq(alice.user.id)).toBe(2);
    expect(await lastReadSeq(bob.user.id)).toBe(0); // reading is not sending

    await send(bobSocket, 'three');
    expect(await lastReadSeq(bob.user.id)).toBe(3);
    expect(await lastReadSeq(alice.user.id)).toBe(2);
  });
});

describe('history order', () => {
  it('orders history by seq, not by created_at', async () => {
    const user = await signUp(server);
    // seq 1 has the latest timestamp and seq 3 the earliest.
    await pool.query(
      `INSERT INTO messages (conversation_id, seq, author_id, client_id, content, created_at)
       SELECT c.id, v.seq, $1, gen_random_uuid(), v.content, v.created_at::timestamptz
       FROM conversations c,
            (VALUES (1, 'first', '2026-01-01 10:00:03Z'),
                    (2, 'second', '2026-01-01 10:00:02Z'),
                    (3, 'third', '2026-01-01 10:00:01Z')) AS v (seq, content, created_at)
       WHERE c.name = 'general'`,
      [user.user.id],
    );

    const res = await api(server).get('/api/messages').set('Cookie', user.cookie);

    expect(res.body.messages.map((m: Message) => m.content)).toEqual(['first', 'second', 'third']);
  });

  it('returns the latest 50 messages by seq', async () => {
    const user = await signUp(server);
    await pool.query(
      `INSERT INTO messages (conversation_id, seq, author_id, client_id, content)
       SELECT c.id, s, $1, gen_random_uuid(), 'message ' || s
       FROM conversations c, generate_series(1, 55) AS s
       WHERE c.name = 'general'`,
      [user.user.id],
    );

    const res = await api(server).get('/api/messages').set('Cookie', user.cookie);

    expect(res.body.messages.map((m: Message) => m.seq)).toEqual(Array.from({ length: 50 }, (_, i) => i + 6));
  });
});

describe('message length', () => {
  it(`rejects a message over ${MESSAGE_MAX_LENGTH} characters with an error event and stores nothing`, async () => {
    const alice = await signUp(server);
    const socket = await connectSocket(server.url, alice.cookie);

    const rejected = nextEvent(socket, 'error');
    socket.emit('new_message', { content: 'x'.repeat(MESSAGE_MAX_LENGTH + 1) });
    expect(await rejected).toEqual({ message: 'Message is too long (maximum 4000 characters).' });
    expect(await generalLastSeq()).toBe(0);
    expect((await pool.query('SELECT 1 FROM messages')).rows).toEqual([]);

    // The limit applies after trimming, and counts characters, not UTF-16 code units
    // (each emoji is two), like the database's char_length().
    expect((await send(socket, `  ${'x'.repeat(MESSAGE_MAX_LENGTH)}  `)).seq).toBe(1);
    expect((await send(socket, '😀'.repeat(MESSAGE_MAX_LENGTH))).seq).toBe(2);
    const { rows } = await pool.query('SELECT char_length(content) AS length FROM messages ORDER BY seq');
    expect(rows).toEqual([{ length: MESSAGE_MAX_LENGTH }, { length: MESSAGE_MAX_LENGTH }]);
  });
});
