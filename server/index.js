// server/index.js
import dotenv           from 'dotenv';
import { fileURLToPath } from 'url';
import { basename, dirname, resolve } from 'path';

import pool            from './db/connection.js';
import { createApp }   from './app.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// The compiled build runs from server/dist/, one level deeper than the source.
const rootEnv = basename(__dirname) === 'dist' ? '../../.env' : '../.env';
dotenv.config({ path: resolve(__dirname, rootEnv) });

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
const PORT = process.env.PORT || 5001;
httpServer.listen(PORT, () => {       // ← httpServer.listen, not app.listen
  console.log(`✅ Server running on port ${PORT}`);
});
