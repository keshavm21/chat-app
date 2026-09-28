// server/http/csrf.ts
// CSRF defenses (docs/v2-design.md §6). With the SameSite=Lax cookie, these keep a
// page on another site from acting as the user, over REST and over the socket.
import type { IncomingMessage } from 'http';
import type { RequestHandler } from 'express';
import { config } from '../config/env.js';
import { AppError, ErrorCode } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

/**
 * The only origin allowed to change state or open a socket: the app's (CLIENT_URL).
 * Normalized the way browsers send it in the Origin header (no path or trailing slash).
 */
export const allowedOrigin = new URL(config.clientUrl).origin;

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * 403 for a state-changing request whose Origin is not the app's. A missing Origin is
 * refused too: browsers always send one with these methods, so only non-browser
 * clients omit it.
 */
export const requireAllowedOrigin: RequestHandler = (req, _res, next) => {
  if (STATE_CHANGING.has(req.method) && req.headers.origin !== allowedOrigin) {
    return next(new AppError(403, ErrorCode.FORBIDDEN, 'Request origin is not allowed.'));
  }
  next();
};

/**
 * 415 for a state-changing request whose body is not JSON (the app always sends JSON,
 * `{}` when it has nothing to say). A JSON body makes a cross-origin request need a
 * CORS preflight, which another site cannot pass, while forms and text/plain do not.
 */
export const requireJsonBody: RequestHandler = (req, _res, next) => {
  if (STATE_CHANGING.has(req.method) && !req.is('application/json')) {
    return next(new AppError(415, ErrorCode.UNSUPPORTED_MEDIA_TYPE, 'Request body must be JSON.'));
  }
  next();
};

/**
 * Socket.io's allowRequest: refuses a connection whose handshake does not come from the
 * app's origin. CORS does not protect WebSockets, and the browser sends the session
 * cookie with them, so without this another site could open a socket as the user.
 */
export function allowSocketHandshake(req: IncomingMessage, callback: (error: string | null, success: boolean) => void) {
  const { origin } = req.headers;
  if (origin === allowedOrigin) return callback(null, true);

  logger.warn({ origin }, 'Socket handshake refused: origin not allowed');
  callback('Origin not allowed', false);
}
