// server/repositories/messages.ts
import type { Queryable } from '../db/transaction.js';

/** A message as REST (GET /api/conversations/:id/messages) and socket (`message`) clients receive it. */
export interface Message {
  id: number;
  conversationId: number;
  seq: number;
  userId: number;
  username: string;
  content: string;
  createdAt: Date;
}

// Selects a Message from `m` (messages) joined to `u` (its author).
const MESSAGE_COLUMNS = `m.id, m.conversation_id AS "conversationId", m.seq, m.author_id AS "userId", u.username,
  m.content, m.created_at AS "createdAt"`;

/**
 * Inserts a message with a seq from allocateSeq() and a server-generated client_id,
 * and returns it with its author's username. If the author is not a member of the
 * conversation, it inserts nothing and returns undefined; the caller must then roll
 * back, so the seq is not used up. The membership check runs in the same statement
 * as the insert, so a concurrent removal cannot slip a message through.
 */
export async function createMessage(
  db: Queryable,
  message: { conversationId: number; seq: number; authorId: number; content: string },
): Promise<Message | undefined> {
  const { rows } = await db.query<Message>(
    `WITH m AS (
       INSERT INTO messages (conversation_id, seq, author_id, client_id, content)
       SELECT $1, $2, $3, gen_random_uuid(), $4
       WHERE EXISTS (SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $3)
       RETURNING *
     )
     SELECT ${MESSAGE_COLUMNS} FROM m JOIN users u ON u.id = m.author_id`,
    [message.conversationId, message.seq, message.authorId, message.content],
  );
  return rows[0];
}

/**
 * A page of a conversation's history, oldest first (by seq): its latest `limit` messages,
 * or with `before`, its latest `limit` messages whose seq is below it. The page is found
 * through the (conversation_id, seq) index, however long the history.
 */
export async function listMessages(
  db: Queryable,
  conversationId: number,
  { before, limit }: { before?: number; limit: number },
): Promise<Message[]> {
  const { rows } = await db.query<Message>(
    `SELECT * FROM (
       SELECT ${MESSAGE_COLUMNS}
       FROM messages m JOIN users u ON u.id = m.author_id
       WHERE m.conversation_id = $1 AND ($2::integer IS NULL OR m.seq < $2)
       ORDER BY m.seq DESC
       LIMIT $3
     ) page
     ORDER BY seq`,
    [conversationId, before ?? null, limit],
  );
  return rows;
}
