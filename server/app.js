// server/app.js
import express          from 'express';
import cors             from 'cors';
import { pinoHttp }     from 'pino-http';
import { createServer } from 'http';
import { Server }       from 'socket.io';

import authRoutes      from './routes/auth.js';
import messagesRoutes  from './routes/messages.js';
import socketHandler   from './socket/socketHandler.js';
import { config }      from './config/env.js';
import { notFound }     from './http/notFound.js';
import { errorHandler } from './http/errorHandler.js';
import { logger }       from './lib/logger.js';

// Builds the Express app, HTTP server and Socket.io server without listening.
// index.js starts it for real; tests create their own instances.
export function createApp() {
  // ── Express app ──────────────────────────────────────────────────────────────
  const app = express();

  const CLIENT_URL = config.clientUrl;

  // First, so every request (including CORS preflights and errors) gets one log line.
  app.use(pinoHttp({ logger }));
  app.use(cors({
    origin: CLIENT_URL,
    credentials: true,
  }));
  app.use(express.json());

  app.use('/api/auth',     authRoutes);
  app.use('/api/messages', messagesRoutes);

  app.get('/api/ping', (_req, res) => res.json({ message: 'Server is alive' }));

  // Must come after every route: unmatched /api requests → 404, then all errors → JSON envelope.
  app.use('/api', notFound);
  app.use(errorHandler);

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
