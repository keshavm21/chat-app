// server/http/requireMember.ts
import type { RequestHandler } from 'express';
import pool from '../db/connection.js';
import { parseId } from '../lib/ids.js';
import { AppError, ErrorCode } from '../lib/errors.js';
import { findMembership, type Membership } from '../repositories/conversations.js';

declare module 'express-serve-static-core' {
  interface Request {
    /** The user's membership of the conversation in the path (:id); set by requireMember. */
    membership?: Membership;
  }
}

/**
 * For /api/conversations/:id/… routes, after requireSession: lets through only members of
 * the conversation, and sets req.membership. Everyone else gets the same 404, whether the
 * conversation exists or not, so a private conversation's existence never leaks (D14).
 */
export const requireMember: RequestHandler = async (req, _res, next) => {
  const conversationId = parseId(req.params.id);
  if (conversationId === undefined) return next(conversationNotFound());

  let membership: Membership | undefined;
  try {
    membership = await findMembership(pool, conversationId, req.user!.id);
  } catch (err) {
    return next(err);
  }
  if (!membership) return next(conversationNotFound());

  req.membership = membership;
  next();
};

/** The answer for a conversation the user is not a member of, or that does not exist. */
export function conversationNotFound(): AppError {
  return new AppError(404, ErrorCode.NOT_FOUND, 'Conversation not found.');
}
