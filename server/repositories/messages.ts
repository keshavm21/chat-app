// server/repositories/messages.ts
import type { Queryable } from '../db/transaction.js';

/** A message as REST (GET /api/messages) and socket (`message`) clients receive it. */
export interface Message {
  id: number;
  seq: number;
  userId: number;
  username: string;
  content: string;
  createdAt: Date;
}

// Selects a Message from `m` (messages) joined to `u` (its author).
const MESSAGE_COLUMNS = `m.id, m.seq, m.author_id AS "userId", u.username, m.content, m.created_at AS "createdAt"`;

/**
 * Inserts a message with a seq from allocateSeq() and a server-generated client_id,
 * and returns it with its author's username.
 */
export async function createMessage(
  db: Queryable,
  message: { conversationId: number; seq: number; authorId: number; content: string },
): Promise<Message> {
  const { rows } = await db.query<Message>(
    `WITH m AS (
       INSERT INTO messages (conversation_id, seq, author_id, client_id, content)
       VALUES ($1, $2, $3, gen_random_uuid(), $4)
       RETURNING *
     )
     SELECT ${MESSAGE_COLUMNS} FROM m JOIN users u ON u.id = m.author_id`,
    [message.conversationId, message.seq, message.authorId, message.content],
  );
  return rows[0];
}

/** The latest `limit` messages of a conversation, oldest first (by seq). */
export async function listLatestMessages(db: Queryable, conversationId: number, limit: number): Promise<Message[]> {
  const { rows } = await db.query<Message>(
    `SELECT * FROM (
       SELECT ${MESSAGE_COLUMNS}
       FROM messages m JOIN users u ON u.id = m.author_id
       WHERE m.conversation_id = $1
       ORDER BY m.seq DESC
       LIMIT $2
     ) latest
     ORDER BY seq`,
    [conversationId, limit],
  );
  return rows;
}
