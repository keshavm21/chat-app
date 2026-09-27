// server/repositories/conversations.ts
import type { Queryable } from '../db/transaction.js';

/**
 * The id of #general, the public channel seeded by migration 0002 that the
 * single-room app uses. Looked up by name, never hard-coded.
 */
export async function findGeneralId(db: Queryable): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    `SELECT id FROM conversations WHERE type = 'channel' AND name = 'general'`,
  );
  if (rows.length === 0) throw new Error('#general does not exist (it is seeded by migration 0002)');
  return rows[0].id;
}

/**
 * Takes the conversation's next message seq. The UPDATE locks the conversation row
 * until the transaction ends, so seqs are handed out in commit order with no gaps,
 * and a rollback gives the seq back. Call it inside a transaction.
 */
export async function allocateSeq(db: Queryable, conversationId: number): Promise<number> {
  const { rows } = await db.query<{ last_seq: number }>(
    `UPDATE conversations SET last_seq = last_seq + 1, last_message_at = now()
     WHERE id = $1
     RETURNING last_seq`,
    [conversationId],
  );
  return rows[0].last_seq;
}

/** Adds a member whose read position starts at the latest message, so earlier history is not unread. */
export async function addMember(
  db: Queryable,
  conversationId: number,
  userId: number,
  role: 'owner' | 'admin' | 'member',
): Promise<void> {
  await db.query(
    `INSERT INTO conversation_members (conversation_id, user_id, role, last_read_seq)
     SELECT id, $2, $3, last_seq FROM conversations WHERE id = $1`,
    [conversationId, userId, role],
  );
}
