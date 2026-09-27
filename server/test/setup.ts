import { afterAll, beforeEach } from 'vitest';
import pool from '../db/connection.js';
import { assertTestDatabaseUrl } from './testDatabase.js';

// Runs in every test file's worker. Checks the connection string the app's
// pool was actually built with (after connection.js has loaded .env). Creating
// the pool does not connect, so this still runs before any query.
assertTestDatabaseUrl(pool.options.connectionString);

beforeEach(async () => {
  // Checked inside the database as well: if the connected database is not a
  // *_test database, the exception aborts the whole statement before TRUNCATE.
  // Then #general is re-seeded with the same statement as migration 0002.
  await pool.query(`
    DO $$
    BEGIN
      IF right(current_database(), 5) <> '_test' THEN
        RAISE EXCEPTION 'Refusing to truncate tables in non-test database %', current_database();
      END IF;
    END $$;
    TRUNCATE users, conversations, direct_conversations, conversation_members, messages RESTART IDENTITY CASCADE;
    INSERT INTO conversations (type, visibility, name) VALUES ('channel', 'public', 'general');
  `);
});

afterAll(async () => {
  await pool.end();
});
