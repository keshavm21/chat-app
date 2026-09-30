// server/routes/users.ts
import express from 'express';
import pool from '../db/connection.js';
import type { createRateLimiters } from '../http/rateLimits.js';
import { requireSession } from '../http/requireSession.js';
import { searchQuerySchema, validationError } from '../http/schemas.js';
import { AppError, ErrorCode } from '../lib/errors.js';
import { USER_SEARCH_LIMIT } from '../lib/limits.js';
import { logger } from '../lib/logger.js';
import { searchUsers } from '../repositories/users.js';

/**
 * The /api/users route: finding someone to message. It takes the app's rate limiters
 * (http/rateLimits.ts): searches are limited per user.
 */
export default function userRoutes(rateLimiters: ReturnType<typeof createRateLimiters>) {
  const router = express.Router();
  router.use(requireSession);

  // ─── GET /api/users?q= ───────────────────────────────────────────────────────
  // Up to USER_SEARCH_LIMIT other users whose username starts with `q`, by username.
  router.get('/', rateLimiters.userSearch, async (req, res, next) => {
    const parsed = searchQuerySchema.safeParse(req.query);
    if (!parsed.success) return next(validationError(parsed.error));

    try {
      res.json({ users: await searchUsers(pool, parsed.data.q, req.user!.id, USER_SEARCH_LIMIT) });
    } catch (err) {
      logger.error({ err }, 'Error searching users');
      next(new AppError(500, ErrorCode.INTERNAL_ERROR, 'Failed to search users.'));
    }
  });

  return router;
}
