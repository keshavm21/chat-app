import pg      from 'pg';
import { config } from '../config/env.js';
import { logger } from '../lib/logger.js';

const { Pool } = pg;

// DATABASE_URL is the normal setup (Neon in production, Docker locally); the
// individual DB_* variables are an alternative.
const pool = config.database.url
  ? new Pool({
      connectionString: config.database.url,
      // Neon requires TLS (certificate verification is a Phase 2 item). A URL with
      // `sslmode=disable`, as used for the local Docker database, overrides this.
      ssl: { rejectUnauthorized: false },
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
