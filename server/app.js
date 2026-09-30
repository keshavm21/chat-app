// server/app.js
import express          from 'express';
import helmet           from 'helmet';
import { pinoHttp }     from 'pino-http';
import { createServer } from 'http';
import { basename, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { Server }       from 'socket.io';

import authRoutes      from './routes/auth.js';
import channelRoutes   from './routes/channels.js';
import conversationRoutes from './routes/conversations.js';
import dmRoutes        from './routes/dms.js';
import userRoutes      from './routes/users.js';
import socketHandler   from './socket/socketHandler.js';
import { startSessionSweep } from './socket/sessionSweep.js';
import { config }       from './config/env.js';
import { allowSocketHandshake, requireAllowedOrigin, requireJsonBody } from './http/csrf.js';
import { createRateLimiters } from './http/rateLimits.js';
import { serveClient }  from './http/spa.js';
import { notFound }     from './http/notFound.js';
import { errorHandler } from './http/errorHandler.js';
import { RATE_LIMITS }  from './lib/limits.js';
import { httpLoggerOptions, logger } from './lib/logger.js';

// The client's production build. The compiled server runs from server/dist/, one level
// deeper than the source.
const here = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIST = resolve(here, basename(here) === 'dist' ? '../..' : '..', 'client/dist');

// Builds the Express app, HTTP server and Socket.io server without listening, and starts
// the timers that stopTimers() ends. index.js starts it for real; tests create their own
// instances, with their own `rateLimits` (default RATE_LIMITS, lib/limits.ts),
// `trustProxy` (default TRUST_PROXY) and `clientDist` (default client/dist).
export function createApp({ rateLimits = RATE_LIMITS, trustProxy = config.trustProxy, clientDist = CLIENT_DIST } = {}) {
  const app = express();

  // How many proxies' X-Forwarded-For to believe for req.ip, which the request logs and
  // the rate limits use. 0 (the default) believes none, so a client cannot pick its IP.
  app.set('trust proxy', trustProxy);

  // ── HTTP server + Socket.io ──────────────────────────────────────────────────
  // Socket.io needs a raw http.Server — it can't be attached to app directly.
  // Created before the routes, which need `io` (logout disconnects sockets; joining and
  // leaving conversations move sockets between rooms).
  const httpServer = createServer(app);

  const io = new Server(httpServer, {
    // WebSocket only, no HTTP long-polling: a WebSocket handshake always carries the
    // browser's Origin, while a same-origin polling GET carries none.
    transports: ['websocket'],
    // Every handshake must come from the app's origin (CORS does not cover WebSockets).
    allowRequest: allowSocketHandshake,
  });

  socketHandler(io);

  // ── Express app ──────────────────────────────────────────────────────────────
  // First, so every request (including CORS preflights and errors) gets one log line.
  app.use(pinoHttp({ logger, ...httpLoggerOptions }));
  // Security headers on every response, errors included; removes X-Powered-By. The
  // Content Security Policy belongs to the SPA and comes later (Phase 8).
  app.use(helmet({ contentSecurityPolicy: false }));
  // No CORS: the client is served from this origin (below), so no other site is ever
  // allowed to read a response. CSRF: a state-changing /api request must come from the
  // app's origin (else 403) and carry JSON (else 415), checked before the body is parsed.
  app.use('/api', requireAllowedOrigin, requireJsonBody);
  app.use(express.json());

  // Login, signup, user search and channel creation limits (429 over them), with fresh counters for each app.
  const rateLimiters = createRateLimiters(rateLimits);

  app.use('/api/auth',          authRoutes(io, rateLimiters));
  app.use('/api/conversations', conversationRoutes(io));
  app.use('/api/channels',      channelRoutes(io, rateLimiters));
  app.use('/api/dms',           dmRoutes(io));
  app.use('/api/users',         userRoutes(rateLimiters));

  app.get('/api/ping', (_req, res) => res.json({ message: 'Server is alive' }));

  // Must come after every route: unmatched /api requests → 404.
  app.use('/api', notFound);

  // The client, for every other GET. Without a build (development) the API stands alone.
  if (serveClient(app, clientDist)) {
    logger.info({ clientDist }, 'Serving the client build');
  } else {
    logger.info({ clientDist }, 'No client build found; serving the API only');
  }

  // Last: all errors → JSON envelope.
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
