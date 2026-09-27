// server/app.js
import express          from 'express';
import cors             from 'cors';
import { createServer } from 'http';
import { Server }       from 'socket.io';

import authRoutes      from './routes/auth.js';
import messagesRoutes  from './routes/messages.js';
import socketHandler   from './socket/socketHandler.js';
import { config }      from './config/env.js';

// Builds the Express app, HTTP server and Socket.io server without listening.
// index.js starts it for real; tests create their own instances.
export function createApp() {
  // ── Express app ──────────────────────────────────────────────────────────────
  const app = express();

  const CLIENT_URL = config.clientUrl;

  app.use(cors({
    origin: CLIENT_URL,
    credentials: true,
  }));
  app.use(express.json());

  app.use('/api/auth',     authRoutes);
  app.use('/api/messages', messagesRoutes);

  app.get('/api/ping', (_req, res) => res.json({ message: 'Server is alive' }));

  // ── HTTP server + Socket.io ──────────────────────────────────────────────────
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

  return { app, httpServer, io };
}
