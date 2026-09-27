// server/repositories/sessions.ts
// Sessions are identified by the SHA-256 of their token (lib/sessions.ts), never the token.
// Lifetimes are compared with the database's clock: the limits (in ms) become intervals in SQL.
import type { Queryable } from '../db/transaction.js';
import {
  SESSION_IDLE_TIMEOUT_MS,
  SESSION_MAX_AGE_MS,
  SESSION_TOUCH_INTERVAL_MS,
  USER_AGENT_MAX_LENGTH,
} from '../lib/limits.js';
import type { User } from './users.js';

/** Creates a session that expires SESSION_MAX_AGE_MS from now. */
export async function createSession(
  db: Queryable,
  session: { tokenHash: Buffer; userId: number; userAgent: string | undefined },
): Promise<void> {
  // Cut in characters (code points), as the constraint's char_length() counts them.
  const userAgent = session.userAgent === undefined
    ? null
    : Array.from(session.userAgent).slice(0, USER_AGENT_MAX_LENGTH).join('');

  await db.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at, user_agent)
     VALUES ($1, $2, now() + $3::double precision * interval '1 millisecond', $4)`,
    [session.tokenHash, session.userId, SESSION_MAX_AGE_MS, userAgent],
  );
}

/**
 * The user of a valid session: not past expires_at, and used within the idle timeout.
 * In the same statement, moves last_seen_at to now if it is more than
 * SESSION_TOUCH_INTERVAL_MS old, so most lookups write nothing.
 */
export async function findSessionUser(db: Queryable, tokenHash: Buffer): Promise<User | undefined> {
  const { rows } = await db.query<User>(
    `WITH valid AS (
       SELECT token_hash, user_id FROM sessions
       WHERE token_hash = $1
         AND expires_at > now()
         AND last_seen_at > now() - $2::double precision * interval '1 millisecond'
     ), touched AS (
       UPDATE sessions SET last_seen_at = now()
       WHERE token_hash = (SELECT token_hash FROM valid)
         AND last_seen_at <= now() - $3::double precision * interval '1 millisecond'
     )
     SELECT u.id, u.username, u.email FROM valid JOIN users u ON u.id = valid.user_id`,
    [tokenHash, SESSION_IDLE_TIMEOUT_MS, SESSION_TOUCH_INTERVAL_MS],
  );
  return rows[0];
}

/**
 * Of these sessions, the ones still valid, by the same rules as findSessionUser. Each
 * counts as used: its last_seen_at moves forward the same way, at most once an hour.
 */
export async function findValidSessions(db: Queryable, tokenHashes: Buffer[]): Promise<Buffer[]> {
  const { rows } = await db.query<{ token_hash: Buffer }>(
    `WITH valid AS (
       SELECT token_hash FROM sessions
       WHERE token_hash = ANY ($1::bytea[])
         AND expires_at > now()
         AND last_seen_at > now() - $2::double precision * interval '1 millisecond'
     ), touched AS (
       UPDATE sessions SET last_seen_at = now()
       WHERE token_hash IN (SELECT token_hash FROM valid)
         AND last_seen_at <= now() - $3::double precision * interval '1 millisecond'
     )
     SELECT token_hash FROM valid`,
    [tokenHashes, SESSION_IDLE_TIMEOUT_MS, SESSION_TOUCH_INTERVAL_MS],
  );
  return rows.map((row) => row.token_hash);
}

/** Deletes every expired or idle session and returns how many there were. */
export async function deleteEndedSessions(db: Queryable): Promise<number> {
  const { rowCount } = await db.query(
    `DELETE FROM sessions
     WHERE expires_at <= now()
        OR last_seen_at <= now() - $1::double precision * interval '1 millisecond'`,
    [SESSION_IDLE_TIMEOUT_MS],
  );
  return rowCount ?? 0;
}

/** Deletes a session. Deleting one that does not exist is not an error. */
export async function deleteSession(db: Queryable, tokenHash: Buffer): Promise<void> {
  await db.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
}
