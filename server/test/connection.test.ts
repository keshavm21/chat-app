import { afterEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import pool from '../db/connection.js';
import { logger } from '../lib/logger.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('database pool', () => {
  it('logs an idle connection killed by the database and keeps working (audit §4.2)', async () => {
    // Make one pool connection idle and note its server-side process id.
    const client = await pool.connect();
    const { rows } = await client.query('SELECT pg_backend_pid() AS pid');
    client.release();

    // Resolves when the app logs the pool error (the spy does not swallow a crash).
    const logged = new Promise<unknown[]>((resolve) => {
      vi.spyOn(logger, 'error').mockImplementation((...args: unknown[]) => resolve(args));
    });

    // Terminate that idle connection from a separate connection, as a database
    // restart or a hosted provider dropping idle connections would.
    const admin = new pg.Client({ connectionString: pool.options.connectionString });
    await admin.connect();
    await admin.query('SELECT pg_terminate_backend($1)', [rows[0].pid]);
    await admin.end();

    const [fields, message] = await logged;
    expect(message).toBe('Idle database client error');
    expect(fields).toEqual({ err: expect.objectContaining({ code: '57P01' }) }); // admin_shutdown

    // The pool replaced the dead connection; queries still work.
    const check = await pool.query('SELECT 1 AS ok');
    expect(check.rows[0].ok).toBe(1);
  });
});
