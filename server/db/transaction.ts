// server/db/transaction.ts
import type pg from 'pg';
import pool from './connection.js';

/** What repositories run their SQL on: the pool, or the client of a transaction. */
export interface Queryable {
  query<R extends pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>;
}

/**
 * Runs `fn` inside a transaction on one pooled client: COMMIT if it resolves,
 * ROLLBACK (and rethrow) if it throws. Emit events only after this resolves.
 */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      // The connection itself failed: discard it instead of returning it to the pool.
      broken = rollbackErr as Error;
    }
    throw err;
  } finally {
    client.release(broken);
  }
}
