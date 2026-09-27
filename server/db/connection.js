import pg      from 'pg';
import { config } from '../config/env.js';
import { logger } from '../lib/logger.js';

const { Pool } = pg;

// Railway (and most PaaS providers) inject a single DATABASE_URL.
// Fall back to individual DB_* vars for local development.
const pool = config.database.url
  ? new Pool({
      connectionString: config.database.url,
      ssl: { rejectUnauthorized: false }, // required on Railway / Render / Heroku
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
