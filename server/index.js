// server/index.js
import { config }      from './config/env.js';   // loads .env and validates it first
import pool            from './db/connection.js';
import { createApp }   from './app.js';

// ── Express app + HTTP server + Socket.io (see app.js) ─────────────────────────
const { httpServer } = createApp();

// ── Database connectivity check ────────────────────────────────────────────────
pool.query('SELECT NOW()', (err, result) => {
  if (err) {
    console.error('❌ Database connection failed:', err.message);
  } else {
    console.log('✅ Database connected at:', result.rows[0].now);
  }
});

// ── Start server ───────────────────────────────────────────────────────────────
const PORT = config.port;
httpServer.listen(PORT, () => {       // ← httpServer.listen, not app.listen
  console.log(`✅ Server running on port ${PORT}`);
});
