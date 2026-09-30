// server/repositories/users.ts
import type { Queryable } from '../db/transaction.js';

export interface User {
  id: number;
  username: string;
  email: string;
}

/** Whether a user already has this email or this username (both already normalized). */
export async function isEmailOrUsernameTaken(db: Queryable, email: string, username: string): Promise<boolean> {
  const { rows } = await db.query('SELECT 1 FROM users WHERE email = $1 OR username = $2', [email, username]);
  return rows.length > 0;
}

export async function createUser(
  db: Queryable,
  user: { username: string; email: string; displayName: string; passwordHash: string },
): Promise<User> {
  const { rows } = await db.query<User>(
    `INSERT INTO users (username, email, display_name, password_hash)
     VALUES ($1, $2, $3, $4)
     RETURNING id, username, email`,
    [user.username, user.email, user.displayName, user.passwordHash],
  );
  return rows[0];
}

export async function findUserByEmail(db: Queryable, email: string): Promise<(User & { passwordHash: string }) | undefined> {
  const { rows } = await db.query<User & { passwordHash: string }>(
    'SELECT id, username, email, password_hash AS "passwordHash" FROM users WHERE email = $1',
    [email],
  );
  return rows[0];
}

/** What other users may see of a user: usernames are public, emails are not. */
export type PublicUser = Pick<User, 'id' | 'username'>;

export async function findUserById(db: Queryable, id: number): Promise<PublicUser | undefined> {
  const { rows } = await db.query<PublicUser>('SELECT id, username FROM users WHERE id = $1', [id]);
  return rows[0];
}

/** The user with this (already normalized) username. */
export async function findUserByUsername(db: Queryable, username: string): Promise<PublicUser | undefined> {
  const { rows } = await db.query<PublicUser>('SELECT id, username FROM users WHERE username = $1', [username]);
  return rows[0];
}

/**
 * Users other than `excludeUserId` whose username starts with `prefix` ('' for any), by
 * username, at most `limit`. starts_with() compares plainly: unlike LIKE, it has no
 * wildcards to escape, and usernames may contain `_`.
 */
export async function searchUsers(db: Queryable, prefix: string, excludeUserId: number, limit: number): Promise<PublicUser[]> {
  const { rows } = await db.query<PublicUser>(
    `SELECT id, username FROM users
     WHERE starts_with(username, $1) AND id <> $2
     ORDER BY username
     LIMIT $3`,
    [prefix, excludeUserId, limit],
  );
  return rows;
}
