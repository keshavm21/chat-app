import pg      from 'pg';
import { config } from '../config/env.js';
import { logger } from '../lib/logger.js';

const { Pool } = pg;

// DATABASE_URL is the normal setup (Neon in production, Docker locally); the
// individual DB_* variables are an alternative.
const pool = config.database.url
  ? new Pool({
      // TLS comes from the URL's sslmode alone: config/env.ts requires
      // sslmode=verify-full (certificate and host name checked) for any database
      // that is not local; the local Docker database uses sslmode=disable.
      connectionString: config.database.url,
    })
  : new Pool({
      user:     config.database.user,
      host:     config.database.host,
      database: config.database.name,
      password: config.database.password,
      port:     config.database.port,
    });

// An idle connection can be dropped at any time (database restart, a hosted provider
// closing idle connections). pg-pool then removes it and emits 'error' on the pool;
// with no listener, Node would crash the whole process. Log it and carry on — the
// pool opens a new connection for the next query.
pool.on('error', (err) => {
  logger.error({ err }, 'Idle database client error');
});

export default pool;
