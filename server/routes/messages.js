// server/routes/messages.js
import express     from 'express';
import pool        from '../db/connection.js';
import verifyToken from '../middleware/verifyToken.js';
import { AppError, ErrorCode } from '../lib/errors.js';

const router = express.Router();

// GET /api/messages — last 50 messages in chronological order (protected)
router.get('/', verifyToken, async (_req, res, next) => {
  try {
    // Subquery: grab the 50 most-recent rows, then re-sort oldest → newest
    // so the client can just append them in order without extra work.
    const { rows } = await pool.query(`
      SELECT id, user_id, username, content, created_at
      FROM (
        SELECT id, user_id, username, content, created_at
        FROM   messages
        ORDER  BY created_at DESC
        LIMIT  50
      ) sub
      ORDER BY created_at ASC
    `);

    const messages = rows.map(row => ({
      id:        row.id,
      userId:    row.user_id,   // camelCase to match what the socket broadcasts
      username:  row.username,
      content:   row.content,
      createdAt: row.created_at,
    }));

    res.json({ messages });
  } catch (err) {
    console.error('Error fetching messages:', err.message);
    next(new AppError(500, ErrorCode.INTERNAL_ERROR, 'Failed to fetch messages.'));
  }
});

export default router;