// server/http/requireSession.ts
import type { RequestHandler } from 'express';
import pool from '../db/connection.js';
import { AppError, ErrorCode } from '../lib/errors.js';
import { hashSessionToken, sessionCookie } from '../lib/sessions.js';
import { findSessionUser } from '../repositories/sessions.js';
import type { User } from '../repositories/users.js';

declare module 'express-serve-static-core' {
  interface Request {
    /** The session's user; set by requireSession. */
    user?: User;
    /** The session itself; set by requireSession. */
    session?: { tokenHash: Buffer };
  }
}

// The same answer whether the cookie is missing, unknown, expired or idle.
const sessionExpired = () =>
  new AppError(401, ErrorCode.UNAUTHENTICATED, 'Your session has expired. Please log in again.');

/** Lets through only requests with a valid session cookie, and sets req.user and req.session. */
export const requireSession: RequestHandler = async (req, _res, next) => {
  const token = sessionCookie.read(req.headers.cookie);
  if (!token) return next(sessionExpired());

  const tokenHash = hashSessionToken(token);
  let user: User | undefined;
  try {
    user = await findSessionUser(pool, tokenHash);
  } catch (err) {
    // A 500 from the error handler, not a 401: a database failure must not log the client out.
    return next(err);
  }
  if (!user) return next(sessionExpired());

  req.user = user;
  req.session = { tokenHash };
  next();
};
