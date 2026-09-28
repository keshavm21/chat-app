// server/app.js
import express          from 'express';
import cors             from 'cors';
import helmet           from 'helmet';
import { pinoHttp }     from 'pino-http';
import { createServer } from 'http';
import { Server }       from 'socket.io';

import authRoutes      from './routes/auth.js';
import messagesRoutes  from './routes/messages.js';
import socketHandler   from './socket/socketHandler.js';
import { startSessionSweep } from './socket/sessionSweep.js';
import { allowedOrigin, allowSocketHandshake, requireAllowedOrigin, requireJsonBody } from './http/csrf.js';
import { notFound }     from './http/notFound.js';
import { errorHandler } from './http/errorHandler.js';
import { logger }       from './lib/logger.js';

// Builds the Express app, HTTP server and Socket.io server without listening, and
// starts the session sweep. index.js starts it for real; tests create their own instances.
export function createApp() {
  const app = express();

  // ── HTTP server + Socket.io ──────────────────────────────────────────────────
  // Socket.io needs a raw http.Server — it can't be attached to app directly.
  // Created before the routes, which need `io` (logout disconnects sockets).
  const httpServer = createServer(app);

  const io = new Server(httpServer, {
    cors: {
      origin: allowedOrigin,
      methods: ['GET', 'POST'],
      credentials: true,
    },
    // CORS does not cover WebSockets: every handshake must come from the app's origin.
    allowRequest: allowSocketHandshake,
  });

  socketHandler(io);

  // ── Express app ──────────────────────────────────────────────────────────────
  // First, so every request (including CORS preflights and errors) gets one log line.
  app.use(pinoHttp({ logger }));
  // Security headers on every response, errors included; removes X-Powered-By. The
  // Content Security Policy belongs to the SPA and comes later (Phase 8).
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors({
    origin: allowedOrigin,
    credentials: true,
  }));
  // CSRF: a state-changing /api request must come from the app's origin (else 403) and
  // carry JSON (else 415). Both run before the body is parsed; preflights never get here.
  app.use('/api', requireAllowedOrigin, requireJsonBody);
  app.use(express.json());

  app.use('/api/auth',     authRoutes(io));
  app.use('/api/messages', messagesRoutes);

  app.get('/api/ping', (_req, res) => res.json({ message: 'Server is alive' }));

  // Must come after every route: unmatched /api requests → 404, then all errors → JSON envelope.
  app.use('/api', notFound);
  app.use(errorHandler);

  // ── Session sweep ────────────────────────────────────────────────────────────
  // Every 5 minutes, disconnects the sockets of ended sessions and deletes their rows.
  // Whoever closes the server stops it first: index.js's shutdown, the tests' close().
  const sessionSweep = startSessionSweep(io);

  return { app, httpServer, io, sessionSweep };
}
