import pg from 'pg';

// The local Docker test database (docker-compose.yml). Used only when
// DATABASE_URL is not set; a DATABASE_URL that is set is never replaced.
export const LOCAL_TEST_DATABASE_URL =
  'postgres://relay:relay@localhost:5433/relay_test?sslmode=disable';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * Throws unless `url` points at a local database whose name ends in `_test`.
 * This is what stops the suite from ever touching relay_dev or a hosted
 * (production-like) database.
 */
export function assertTestDatabaseUrl(url: string | undefined): string {
  if (!url) {
    throw new Error(`Refusing to run tests: DATABASE_URL is not set. Expected e.g. ${LOCAL_TEST_DATABASE_URL}`);
  }

  // Resolve host and database exactly the way the app's pg Pool will
  // (a Client copies them from its parsed connection parameters; it does not connect).
  const { host, database } = new pg.Client({ connectionString: url });

  if (!database?.endsWith('_test')) {
    throw new Error(
      `Refusing to run tests: database "${database}" does not end in "_test". ` +
      `Point DATABASE_URL at relay_test, e.g. ${LOCAL_TEST_DATABASE_URL}`,
    );
  }
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(`Refusing to run tests: host "${host}" is not local. Tests only run against a local database.`);
  }
  return url;
}

/** The URL the suite runs against: DATABASE_URL, or the local test database if unset. */
export function resolveTestDatabaseUrl(): string {
  return assertTestDatabaseUrl(process.env.DATABASE_URL ?? LOCAL_TEST_DATABASE_URL);
}
