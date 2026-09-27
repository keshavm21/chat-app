import pg      from 'pg';
import { config } from '../config/env.js';

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

export default pool;
