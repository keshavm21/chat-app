import { describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import pool from '../db/connection.js';
import { EMAIL_MAX_LENGTH, USERNAME_PATTERN } from '../lib/limits.js';

// Migration 0002's constraints, tested directly in the database without the app.
// Every test starts from the per-test reset (test/setup.ts): empty tables and #general.

type Row = Record<string, unknown>;

const CHECK = '23514';
const UNIQUE = '23505';
const FOREIGN_KEY = '23503';
const NOT_NULL = '23502';

async function insert(table: string, row: Row): Promise<Row> {
  const columns = Object.keys(row);
  const { rows } = await pool.query(
    `INSERT INTO ${table} (${columns.join(', ')})
     VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})
     RETURNING *`,
    Object.values(row),
  );
  return rows[0];
}

async function generalId() {
  const { rows } = await pool.query(`SELECT id FROM conversations WHERE name = 'general'`);
  return rows[0].id as number;
}

// Valid rows for each table, with `overrides` applied (null included); missing parents are created.
let n = 0;
const factories: Record<string, (overrides?: Row) => Promise<Row>> = {
  users: (overrides = {}) => {
    n += 1;
    return insert('users', {
      username: `user${n}`, email: `user${n}@example.test`, display_name: `User ${n}`, password_hash: 'hash', ...overrides,
    });
  },
  conversations: (overrides = {}) => {
    n += 1;
    return insert('conversations', { type: 'channel', visibility: 'public', name: `channel-${n}`, ...overrides });
  },
  direct_conversations: async (overrides = {}) => {
    const a = await user(); // created first, so a.id < b.id
    const b = await user();
    const dm = await conversation({ type: 'dm', visibility: null, name: null });
    return insert('direct_conversations', { conversation_id: dm.id, user_a_id: a.id, user_b_id: b.id, ...overrides });
  },
  conversation_members: async (overrides = {}) =>
    insert('conversation_members', {
      conversation_id: await generalId(), user_id: (await user()).id, role: 'member', ...overrides,
    }),
  messages: async (overrides = {}) => {
    n += 1;
    return insert('messages', {
      conversation_id: await generalId(), seq: n, author_id: (await user()).id, client_id: randomUUID(), content: 'hello',
      ...overrides,
    });
  },
};
const { users: user, conversations: conversation, direct_conversations: directConversation } = factories;
const { conversation_members: member, messages: message } = factories;

/** Whether the insert succeeds; a rejection must come from `constraint`, any other error fails the test. */
async function accepted(insertion: Promise<unknown>, constraint: string): Promise<boolean> {
  try {
    await insertion;
    return true;
  } catch (err) {
    expect(err).toMatchObject({ code: CHECK, constraint });
    return false;
  }
}

describe('users', () => {
  it.each([
    ['abc', true],
    ['x'.repeat(32), true],
    ['under_score_42', true],
    ['ab', false],
    ['x'.repeat(33), false],
    ['Alice', false],
    ['has space', false],
    ['has-hyphen', false],
    ['élise', false],
    ['', false],
  ])('username %j: accepted = %s, the same as USERNAME_PATTERN (lib/limits.ts)', async (username, expected) => {
    expect(USERNAME_PATTERN.test(username)).toBe(expected);
    expect(await accepted(user({ username }), 'users_username_format')).toBe(expected);
  });

  it('only accepts lowercase emails', async () => {
    expect(await accepted(user({ email: 'Alice@example.test' }), 'users_email_lowercase')).toBe(false);
    expect(await accepted(user({ email: 'alice@example.test' }), 'users_email_lowercase')).toBe(true);
  });

  it(`accepts emails up to EMAIL_MAX_LENGTH (${EMAIL_MAX_LENGTH}, lib/limits.ts) characters`, async () => {
    const email = (length: number) => `${'a'.repeat(length - '@example.test'.length)}@example.test`;

    expect(await accepted(user({ email: email(EMAIL_MAX_LENGTH) }), 'users_email_length')).toBe(true);
    expect(await accepted(user({ email: email(EMAIL_MAX_LENGTH + 1) }), 'users_email_length')).toBe(false);
  });

  it('accepts display names of 1–50 characters', async () => {
    for (const [displayName, expected] of [['', false], ['A', true], ['x'.repeat(50), true], ['x'.repeat(51), false]] as const) {
      expect(await accepted(user({ display_name: displayName }), 'users_display_name_length')).toBe(expected);
    }
  });

  it('rejects a duplicate username or email', async () => {
    await user({ username: 'alice', email: 'alice@example.test' });

    await expect(user({ username: 'alice' })).rejects.toMatchObject({ code: UNIQUE, constraint: 'users_username_key' });
    await expect(user({ email: 'alice@example.test' })).rejects.toMatchObject({ code: UNIQUE, constraint: 'users_email_key' });
  });
});

describe('conversations', () => {
  it('only allows the types channel and dm, and the visibilities public and private', async () => {
    await expect(conversation({ type: 'group', visibility: null, name: null })).rejects.toMatchObject({
      code: CHECK, constraint: 'conversations_type_values',
    });
    await expect(conversation({ visibility: 'secret' })).rejects.toMatchObject({
      code: CHECK, constraint: 'conversations_visibility_values',
    });
    await conversation({ visibility: 'private' });
  });

  it('requires a name and a visibility for channels, and neither for DMs', async () => {
    for (const [row, expected] of [
      [{ type: 'channel', visibility: 'public', name: 'ok' }, true],
      [{ type: 'channel', visibility: null, name: 'no-visibility' }, false],
      [{ type: 'channel', visibility: 'public', name: null }, false],
      [{ type: 'dm', visibility: null, name: null }, true],
      [{ type: 'dm', visibility: null, name: 'named-dm' }, false],
      [{ type: 'dm', visibility: 'private', name: null }, false],
    ] as const) {
      expect(await accepted(conversation(row), 'conversations_shape'), JSON.stringify(row)).toBe(expected);
    }
  });

  it.each([
    ['a', true],
    ['x'.repeat(40), true],
    ['my-channel-2', true],
    ['', false],
    ['x'.repeat(41), false],
    ['General', false],
    ['has space', false],
    ['under_score', false],
  ])('channel name %j: accepted = %s', async (name, expected) => {
    expect(await accepted(conversation({ name }), 'conversations_name_format')).toBe(expected);
  });

  it('rejects a second channel with the same name, while DMs have no name', async () => {
    await expect(conversation({ name: 'general' })).rejects.toMatchObject({
      code: UNIQUE, constraint: 'conversations_channel_name_key',
    });

    await conversation({ type: 'dm', visibility: null, name: null });
    await conversation({ type: 'dm', visibility: null, name: null });
  });

  it('keeps a channel when its creator is deleted, with created_by set to NULL', async () => {
    const creator = await user();
    const channel = await conversation({ created_by: creator.id });

    await pool.query('DELETE FROM users WHERE id = $1', [creator.id]);

    const { rows } = await pool.query('SELECT created_by FROM conversations WHERE id = $1', [channel.id]);
    expect(rows).toEqual([{ created_by: null }]);
  });
});

describe('direct_conversations', () => {
  it('requires user_a_id < user_b_id, which rules out self-DMs and reversed pairs', async () => {
    const a = await user();
    const b = await user();

    for (const [userA, userB] of [[a.id, a.id], [b.id, a.id]]) {
      await expect(directConversation({ user_a_id: userA, user_b_id: userB })).rejects.toMatchObject({
        code: CHECK, constraint: 'direct_conversations_ordered_pair',
      });
    }
    await directConversation({ user_a_id: a.id, user_b_id: b.id });
  });

  it('allows only one DM per pair of users', async () => {
    const dm = await directConversation();

    await expect(directConversation({ user_a_id: dm.user_a_id, user_b_id: dm.user_b_id })).rejects.toMatchObject({
      code: UNIQUE, constraint: 'direct_conversations_pair_key',
    });
  });

  it('is deleted with its conversation, and keeps its users from being deleted', async () => {
    const dm = await directConversation();

    await expect(pool.query('DELETE FROM users WHERE id = $1', [dm.user_a_id])).rejects.toMatchObject({
      code: FOREIGN_KEY, constraint: 'direct_conversations_user_a_id_fkey',
    });
    await pool.query('DELETE FROM conversations WHERE id = $1', [dm.conversation_id]);
    expect((await pool.query('SELECT * FROM direct_conversations')).rows).toEqual([]);
  });
});

describe('conversation_members', () => {
  it('only allows the roles owner, admin and member', async () => {
    for (const role of ['owner', 'admin', 'member']) await member({ role });

    await expect(member({ role: 'guest' })).rejects.toMatchObject({
      code: CHECK, constraint: 'conversation_members_role_values',
    });
  });

  it('allows one row per user per conversation', async () => {
    const row = await member();

    await expect(member({ user_id: row.user_id })).rejects.toMatchObject({
      code: UNIQUE, constraint: 'conversation_members_pkey',
    });
  });

  it('is deleted with its user or its conversation', async () => {
    const channel = await conversation();
    const staying = await member({ conversation_id: channel.id });
    await member({ conversation_id: channel.id });
    await member({ user_id: staying.user_id });

    await pool.query('DELETE FROM users WHERE id = $1', [staying.user_id]);
    await pool.query('DELETE FROM conversations WHERE id = $1', [channel.id]);

    expect((await pool.query('SELECT * FROM conversation_members')).rows).toEqual([]);
  });
});

describe('messages', () => {
  it('requires 1–4000 characters of content unless the message is deleted', async () => {
    for (const [row, expected] of [
      [{ content: 'x' }, true],
      [{ content: 'x'.repeat(4000) }, true],
      [{ content: '' }, false],
      [{ content: 'x'.repeat(4001) }, false],
      [{ content: '', deleted_at: new Date() }, true],
    ] as const) {
      expect(await accepted(message(row), 'messages_content_length'), JSON.stringify(row).slice(0, 60)).toBe(expected);
    }
  });

  it('allows each seq once per conversation', async () => {
    await message({ seq: 1 });

    await expect(message({ seq: 1 })).rejects.toMatchObject({ code: UNIQUE, constraint: 'messages_conversation_seq_key' });
    await message({ seq: 1, conversation_id: (await conversation()).id }); // another conversation
  });

  it('allows each client_id once per author, and requires one (there is no default)', async () => {
    const first = await message();

    await expect(message({ author_id: first.author_id, client_id: first.client_id })).rejects.toMatchObject({
      code: UNIQUE, constraint: 'messages_author_client_id_key',
    });
    await message({ client_id: first.client_id }); // another author may reuse it

    await expect(
      pool.query('INSERT INTO messages (conversation_id, seq, author_id, content) VALUES ($1, 99, $2, $3)', [
        first.conversation_id, first.author_id, 'no client_id',
      ]),
    ).rejects.toMatchObject({ code: NOT_NULL, column: 'client_id' });
  });

  it('keeps an author with messages from being deleted, and is deleted with its conversation', async () => {
    const channel = await conversation();
    const row = await message({ conversation_id: channel.id });

    await expect(pool.query('DELETE FROM users WHERE id = $1', [row.author_id])).rejects.toMatchObject({
      code: FOREIGN_KEY, constraint: 'messages_author_id_fkey',
    });
    await pool.query('DELETE FROM conversations WHERE id = $1', [channel.id]);
    expect((await pool.query('SELECT * FROM messages')).rows).toEqual([]);
  });
});

describe('NOT NULL columns', () => {
  it.each([
    ['users', 'username'], ['users', 'email'], ['users', 'display_name'], ['users', 'password_hash'],
    ['users', 'created_at'], ['users', 'updated_at'],
    ['conversations', 'type'], ['conversations', 'last_seq'], ['conversations', 'created_at'], ['conversations', 'updated_at'],
    ['direct_conversations', 'conversation_id'], ['direct_conversations', 'user_a_id'], ['direct_conversations', 'user_b_id'],
    ['conversation_members', 'conversation_id'], ['conversation_members', 'user_id'], ['conversation_members', 'role'],
    ['conversation_members', 'last_read_seq'], ['conversation_members', 'joined_at'],
    ['messages', 'conversation_id'], ['messages', 'seq'], ['messages', 'author_id'], ['messages', 'client_id'],
    ['messages', 'content'], ['messages', 'created_at'],
  ])('%s.%s rejects NULL', async (table, column) => {
    await expect(factories[table]({ [column]: null })).rejects.toMatchObject({ code: NOT_NULL, column });
  });
});
