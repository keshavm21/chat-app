// server/index.js
import { config }      from './config/env.js';   // loads .env and validates it first
import pool            from './db/connection.js';
import { createApp }   from './app.js';
import { logger }      from './lib/logger.js';

// ── Express app + HTTP server + Socket.io (see app.js) ─────────────────────────
const { httpServer } = createApp();

// ── Database connectivity check ────────────────────────────────────────────────
pool.query('SELECT NOW()', (err, result) => {
  if (err) {
    logger.error({ err }, 'Database connection failed');
  } else {
    logger.info({ databaseTime: result.rows[0].now }, 'Database connected');
  }
});

// ── Start server ───────────────────────────────────────────────────────────────
const PORT = config.port;
httpServer.listen(PORT, () => {       // ← httpServer.listen, not app.listen
  logger.info({ port: PORT }, 'Server running');
});
