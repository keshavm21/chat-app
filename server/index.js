// server/index.js
import { config }      from './config/env.js';   // loads .env and validates it first
import pool            from './db/connection.js';
import { createApp }   from './app.js';
import { logger }      from './lib/logger.js';

// ── Express app + HTTP server + Socket.io (see app.js) ─────────────────────────
const { httpServer, io } = createApp();

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

// ── Graceful shutdown ──────────────────────────────────────────────────────────
// Render sends SIGTERM on every deploy/restart; Ctrl-C sends SIGINT locally.
const SHUTDOWN_TIMEOUT_MS = 10_000;
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) {
    logger.warn({ signal }, 'Shutdown already in progress; ignoring signal');
    return;
  }
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down');

  // If something hangs (e.g. a request that never finishes), exit anyway.
  // unref(): this timer on its own must not keep the process alive.
  setTimeout(() => {
    logger.error({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, 'Shutdown timed out; forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();

  try {
    // Disconnects every socket (clients reconnect to the next instance), then stops
    // the HTTP server accepting connections and waits for in-flight requests.
    await io.close();
    // After that, so queries still running (e.g. saving a message) can finish.
    await pool.end();
    logger.info('Shutdown complete');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'Shutdown failed');
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
