import { defineConfig } from 'vitest/config';
import { resolveTestDatabaseUrl } from './test/testDatabase.js';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/globalSetup.ts'],
    setupFiles: ['test/setup.ts'],
    // All test files share relay_test and truncate it, so run them one at a time.
    fileParallelism: false,
    env: {
      // Set before the app's modules load, so connection.js never falls back to
      // the DATABASE_URL in the root .env (relay_dev).
      DATABASE_URL: resolveTestDatabaseUrl(),
      LOG_LEVEL: 'silent', // keep test output free of request/app logs
    },
  },
});
