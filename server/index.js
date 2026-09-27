// server/index.js
import express          from 'express';
import cors             from 'cors';
import dotenv           from 'dotenv';
import { createServer } from 'http';
import { Server }       from 'socket.io';
import { fileURLToPath } from 'url';
import { basename, dirname, resolve } from 'path';

import pool            from './db/connection.js';
import authRoutes      from './routes/auth.js';
import messagesRoutes  from './routes/messages.js';  // ← NEW
import socketHandler   from './socket/socketHandler.js'; // ← NEW

const __dirname = dirname(fileURLToPath(import.meta.url));
// The compiled build runs from server/dist/, one level deeper than the source.
const rootEnv = basename(__dirname) === 'dist' ? '../../.env' : '../.env';
dotenv.config({ path: resolve(__dirname, rootEnv) });

// ── Express app ────────────────────────────────────────────────────────────────
const app = express();

const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';

app.use(cors({
  origin: CLIENT_URL,
  credentials: true,
}));
app.use(express.json());

app.use('/api/auth',     authRoutes);
app.use('/api/messages', messagesRoutes); // ← NEW

app.get('/api/ping', (_req, res) => res.json({ message: 'Server is alive' }));

// ── HTTP server + Socket.io ────────────────────────────────────────────────────
// Socket.io needs a raw http.Server — it can't be attached to app directly.
const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: CLIENT_URL,
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

socketHandler(io);

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