import { fileURLToPath } from 'url';
import { runner } from 'node-pg-migrate';
import { resolveTestDatabaseUrl } from './testDatabase.js';

// Runs once, before any test file. The guard throws before any query runs.
export default async function setup() {
  const databaseUrl = resolveTestDatabaseUrl();

  await runner({
    databaseUrl,
    dir: fileURLToPath(new URL('../migrations', import.meta.url)),
    migrationsTable: 'pgmigrations',
    direction: 'up',
    log: () => {},
  });
}
