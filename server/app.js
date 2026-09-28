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
import { config }       from './config/env.js';
import { allowedOrigin, allowSocketHandshake, requireAllowedOrigin, requireJsonBody } from './http/csrf.js';
import { createRateLimiters } from './http/rateLimits.js';
import { notFound }     from './http/notFound.js';
import { errorHandler } from './http/errorHandler.js';
import { RATE_LIMITS }  from './lib/limits.js';
import { httpLoggerOptions, logger } from './lib/logger.js';

// Builds the Express app, HTTP server and Socket.io server without listening, and starts
// the timers that stopTimers() ends. index.js starts it for real; tests create their own
// instances, with their own `rateLimits` (default RATE_LIMITS, lib/limits.ts) and
// `trustProxy` (default TRUST_PROXY).
export function createApp({ rateLimits = RATE_LIMITS, trustProxy = config.trustProxy } = {}) {
  const app = express();

  // How many proxies' X-Forwarded-For to believe for req.ip, which the request logs and
  // the rate limits use. 0 (the default) believes none, so a client cannot pick its IP.
  app.set('trust proxy', trustProxy);

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
  app.use(pinoHttp({ logger, ...httpLoggerOptions }));
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

  // Login and signup limits (429 over them), with fresh counters for each app.
  const rateLimiters = createRateLimiters(rateLimits);

  app.use('/api/auth',     authRoutes(io, rateLimiters));
  app.use('/api/messages', messagesRoutes);

  app.get('/api/ping', (_req, res) => res.json({ message: 'Server is alive' }));

  // Must come after every route: unmatched /api requests → 404, then all errors → JSON envelope.
  app.use('/api', notFound);
  app.use(errorHandler);

  // ── Session sweep ────────────────────────────────────────────────────────────
  // Every 5 minutes, disconnects the sockets of ended sessions and deletes their rows.
  const sessionSweep = startSessionSweep(io);

  // Stops every timer the app started (the session sweep, waiting for a run in progress,
  // and the rate limiters' cleanup). Whoever closes the server calls it first:
  // index.js's shutdown, the tests' close().
  async function stopTimers() {
    rateLimiters.stop();
    await sessionSweep.stop();
  }

  return { app, httpServer, io, stopTimers };
}
