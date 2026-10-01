// server/repositories/conversations.ts
import type { Queryable } from '../db/transaction.js';

/**
 * The name of #general, the public channel seeded by migration 0002 that every user joins
 * at signup. A private channel may have the same name (migration 0004): check visibility too.
 */
export const GENERAL_CHANNEL = 'general';

export type ConversationType = 'channel' | 'dm';
export type Visibility = 'public' | 'private';
export type Role = 'owner' | 'admin' | 'member';

/**
 * A conversation as one of its members sees it (GET /api/conversations, the responses that
 * create or join one, and `conversation:joined`). A DM is named after the other user.
 */
export interface ConversationSummary {
  id: number;
  type: ConversationType;
  /** A channel's; null for a DM. */
  visibility: Visibility | null;
  name: string;
  topic: string | null;
  /** My role in it. */
  role: Role;
  /** The seq of its latest message (0: none yet). */
  lastSeq: number;
  /** The seq of the latest message I have read. */
  lastReadSeq: number;
  /** lastSeq − lastReadSeq: never negative, as markRead never moves past lastSeq. */
  unreadCount: number;
  lastMessageAt: Date | null;
  /**
   * What GET /api/conversations sorts by: the latest message, or when I joined if that is
   * later. A new message sets it to the message's createdAt (the same instant as lastMessageAt).
   */
  lastActivityAt: Date;
}

/** A user's membership of a conversation, with what the conversation routes check (http/requireMember.ts). */
export interface Membership {
  conversationId: number;
  type: ConversationType;
  visibility: Visibility | null;
  /** A channel's name; null for a DM. */
  name: string | null;
  role: Role;
}

/** A public channel as GET /api/channels lists it. */
export interface ChannelListing {
  id: number;
  name: string;
  topic: string | null;
  isMember: boolean;
}

// The ConversationSummary of each conversation of user $1 (`mine` is their membership).
const SUMMARY = `
  SELECT c.id, c.type, c.visibility,
         CASE WHEN c.type = 'dm' THEN other.username ELSE c.name END AS name,
         c.topic, mine.role,
         c.last_seq AS "lastSeq", mine.last_read_seq AS "lastReadSeq",
         c.last_seq - mine.last_read_seq AS "unreadCount",
         c.last_message_at AS "lastMessageAt",
         GREATEST(c.last_message_at, mine.joined_at) AS "lastActivityAt"
  FROM conversation_members mine
  JOIN conversations c ON c.id = mine.conversation_id
  LEFT JOIN direct_conversations dc ON dc.conversation_id = c.id
  LEFT JOIN users other ON other.id = CASE WHEN dc.user_a_id = $1 THEN dc.user_b_id ELSE dc.user_a_id END
  WHERE mine.user_id = $1`;

/**
 * The user's conversations, the most recently active first (lastActivityAt: their latest
 * message, or when the user joined if that is later, so a channel just joined comes first).
 */
export async function listConversations(db: Queryable, userId: number): Promise<ConversationSummary[]> {
  const { rows } = await db.query<ConversationSummary>(
    `${SUMMARY}
     ORDER BY "lastActivityAt" DESC, c.id DESC`,
    [userId],
  );
  return rows;
}

/** One conversation as `userId` sees it, or undefined if they are not a member. */
export async function findConversationSummary(
  db: Queryable,
  conversationId: number,
  userId: number,
): Promise<ConversationSummary | undefined> {
  const { rows } = await db.query<ConversationSummary>(`${SUMMARY} AND c.id = $2`, [userId, conversationId]);
  return rows[0];
}

/** The ids of every conversation the user is a member of (for the socket's rooms). */
export async function listMemberConversationIds(db: Queryable, userId: number): Promise<number[]> {
  const { rows } = await db.query<{ conversation_id: number }>(
    'SELECT conversation_id FROM conversation_members WHERE user_id = $1',
    [userId],
  );
  return rows.map((row) => row.conversation_id);
}

/** The user's membership of the conversation, or undefined if they are not a member (or it does not exist). */
export async function findMembership(db: Queryable, conversationId: number, userId: number): Promise<Membership | undefined> {
  const { rows } = await db.query<Membership>(
    `SELECT c.id AS "conversationId", c.type, c.visibility, c.name, m.role
     FROM conversation_members m JOIN conversations c ON c.id = m.conversation_id
     WHERE m.conversation_id = $1 AND m.user_id = $2`,
    [conversationId, userId],
  );
  return rows[0];
}

/**
 * Public channels whose name starts with `prefix` ('' for all), by name, at most `limit`,
 * each with whether the user is a member. starts_with() compares plainly: unlike LIKE, it
 * has no wildcards to escape.
 */
export async function listPublicChannels(
  db: Queryable,
  userId: number,
  prefix: string,
  limit: number,
): Promise<ChannelListing[]> {
  const { rows } = await db.query<ChannelListing>(
    `SELECT c.id, c.name, c.topic,
            EXISTS (SELECT 1 FROM conversation_members m WHERE m.conversation_id = c.id AND m.user_id = $1) AS "isMember"
     FROM conversations c
     WHERE c.type = 'channel' AND c.visibility = 'public' AND starts_with(c.name, $2)
     ORDER BY c.name
     LIMIT $3`,
    [userId, prefix, limit],
  );
  return rows;
}

/**
 * Creates a channel and returns its id; the caller adds its creator as the owner in the
 * same transaction. A public channel's name taken by another public channel violates
 * conversations_public_channel_name_key; private channels' names need not be unique.
 */
export async function createChannel(
  db: Queryable,
  channel: { name: string; topic: string | null; visibility: Visibility; createdBy: number },
): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO conversations (type, visibility, name, topic, created_by)
     VALUES ('channel', $1, $2, $3, $4)
     RETURNING id`,
    [channel.visibility, channel.name, channel.topic, channel.createdBy],
  );
  return rows[0].id;
}

/**
 * Adds a member whose read position starts at the latest message, so earlier history is
 * not unread. Returns false, changing nothing, if they are a member already.
 */
export async function addMember(db: Queryable, conversationId: number, userId: number, role: Role): Promise<boolean> {
  const { rowCount } = await db.query(
    `INSERT INTO conversation_members (conversation_id, user_id, role, last_read_seq)
     SELECT id, $2, $3, last_seq FROM conversations WHERE id = $1
     ON CONFLICT (conversation_id, user_id) DO NOTHING`,
    [conversationId, userId, role],
  );
  return rowCount === 1;
}

/**
 * Makes the user a member of a public channel, as addMember does. Returns false, changing
 * nothing, if they are a member already or the conversation is not a public channel.
 */
export async function joinPublicChannel(db: Queryable, conversationId: number, userId: number): Promise<boolean> {
  const { rowCount } = await db.query(
    `INSERT INTO conversation_members (conversation_id, user_id, role, last_read_seq)
     SELECT id, $2, 'member', last_seq FROM conversations
     WHERE id = $1 AND type = 'channel' AND visibility = 'public'
     ON CONFLICT (conversation_id, user_id) DO NOTHING`,
    [conversationId, userId],
  );
  return rowCount === 1;
}

/** Ends a membership. Ending one that does not exist is not an error. */
export async function removeMember(db: Queryable, conversationId: number, userId: number): Promise<void> {
  await db.query('DELETE FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [conversationId, userId]);
}

/** The id of the DM between two users (userA < userB), if they have one. */
export async function findDirectConversationId(db: Queryable, userA: number, userB: number): Promise<number | undefined> {
  const { rows } = await db.query<{ conversation_id: number }>(
    'SELECT conversation_id FROM direct_conversations WHERE user_a_id = $1 AND user_b_id = $2',
    [userA, userB],
  );
  return rows[0]?.conversation_id;
}

/**
 * Creates the DM of two users (userA < userB, as direct_conversations_ordered_pair wants)
 * and returns its id, without members. If the pair already has a DM, it returns undefined
 * and the caller must roll back, which removes the conversation row inserted here. While
 * another transaction is inserting the same pair, the insert waits for it to end.
 */
export async function createDirectConversation(
  db: Queryable,
  dm: { userA: number; userB: number; createdBy: number },
): Promise<number | undefined> {
  const { rows } = await db.query<{ conversation_id: number }>(
    `WITH c AS (
       INSERT INTO conversations (type, created_by) VALUES ('dm', $3) RETURNING id
     )
     INSERT INTO direct_conversations (conversation_id, user_a_id, user_b_id)
     SELECT id, $1, $2 FROM c
     ON CONFLICT (user_a_id, user_b_id) DO NOTHING
     RETURNING conversation_id`,
    [dm.userA, dm.userB, dm.createdBy],
  );
  return rows[0]?.conversation_id;
}

/**
 * The id of #general, the public channel seeded by migration 0002 that every user joins
 * at signup. Looked up by name, never hard-coded.
 */
export async function findGeneralId(db: Queryable): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    `SELECT id FROM conversations WHERE type = 'channel' AND visibility = 'public' AND name = $1`,
    [GENERAL_CHANNEL],
  );
  if (rows.length === 0) throw new Error('#general does not exist (it is seeded by migration 0002)');
  return rows[0].id;
}

/**
 * Takes the conversation's next message seq, or returns undefined if there is no such
 * conversation. The UPDATE locks the conversation row until the transaction ends, so seqs
 * are handed out in commit order with no gaps, and a rollback gives the seq back. Call it
 * inside a transaction.
 */
export async function allocateSeq(db: Queryable, conversationId: number): Promise<number | undefined> {
  const { rows } = await db.query<{ last_seq: number }>(
    `UPDATE conversations SET last_seq = last_seq + 1, last_message_at = now()
     WHERE id = $1
     RETURNING last_seq`,
    [conversationId],
  );
  return rows[0]?.last_seq;
}

/**
 * Moves a member's read position forward to `seq`. It never moves backwards, and never
 * past the conversation's latest message, so the unread count cannot go negative.
 */
export async function markRead(db: Queryable, conversationId: number, userId: number, seq: number): Promise<void> {
  await db.query(
    `UPDATE conversation_members m SET last_read_seq = GREATEST(m.last_read_seq, LEAST($3, c.last_seq))
     FROM conversations c
     WHERE c.id = m.conversation_id AND m.conversation_id = $1 AND m.user_id = $2`,
    [conversationId, userId, seq],
  );
}
