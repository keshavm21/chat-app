// server/routes/messages.js
import express     from 'express';
import pool        from '../db/connection.js';
import verifyToken from '../middleware/verifyToken.js';
import { AppError, ErrorCode } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { findGeneralId } from '../repositories/conversations.js';
import { listLatestMessages } from '../repositories/messages.js';

const router = express.Router();

// GET /api/messages — the last 50 messages of #general, oldest first by seq (protected)
router.get('/', verifyToken, async (_req, res, next) => {
  try {
    // Oldest → newest, so the client can just append them in order without extra work.
    // Same shape as the socket's `message` event.
    const messages = await listLatestMessages(pool, await findGeneralId(pool), 50);

    res.json({ messages });
  } catch (err) {
    logger.error({ err }, 'Error fetching messages');
    next(new AppError(500, ErrorCode.INTERNAL_ERROR, 'Failed to fetch messages.'));
  }
});

export default router;