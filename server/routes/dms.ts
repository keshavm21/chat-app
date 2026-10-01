// server/routes/dms.ts
import express from 'express';
import type { Server } from 'socket.io';
import pool from '../db/connection.js';
import { withTransaction } from '../db/transaction.js';
import { requireSession } from '../http/requireSession.js';
import { createDmSchema, validationError } from '../http/schemas.js';
import { AppError, ErrorCode } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import {
  addMember,
  createDirectConversation,
  findConversationSummary,
  findDirectConversationId,
} from '../repositories/conversations.js';
import { findUserById } from '../repositories/users.js';
import { joinedConversation } from '../socket/rooms.js';

// Thrown inside the create transaction to roll it back when a concurrent request created
// the same DM first.
class DmExistsError extends Error {}

/**
 * The /api/dms route: opens the DM with another user. It takes `io`, because a new DM puts
 * both users' sockets in its room.
 */
export default function dmRoutes(io: Server) {
  const router = express.Router();
  router.use(requireSession);

  // ─── POST /api/dms ───────────────────────────────────────────────────────────
  // Returns the DM with `userId`, creating it if there is none: 201 when created, 200 when
  // it already existed. Concurrent requests for one pair create one DM.
  router.post('/', async (req, res, next) => {
    const parsed = createDmSchema.safeParse(req.body);
    if (!parsed.success) return next(validationError(parsed.error));
    const me = req.user!.id;
    const other = parsed.data.userId;
    if (other === me) {
      const message = 'You cannot start a conversation with yourself.';
      return next(new AppError(400, ErrorCode.VALIDATION_ERROR, message, [{ field: 'userId', message }]));
    }

    try {
      if (!(await findUserById(pool, other))) return next(new AppError(404, ErrorCode.NOT_FOUND, 'User not found.'));

      // A DM's pair is stored in one order (direct_conversations_ordered_pair).
      const [userA, userB] = me < other ? [me, other] : [other, me];
      const existing = await findDirectConversationId(pool, userA, userB);
      if (existing !== undefined) {
        return res.json({ conversation: await findConversationSummary(pool, existing, me) });
      }

      const created = await withTransaction(async (client) => {
        const id = await createDirectConversation(client, { userA, userB, createdBy: me });
        if (id === undefined) throw new DmExistsError();
        await addMember(client, id, userA, 'member');
        await addMember(client, id, userB, 'member');
        return {
          mine: (await findConversationSummary(client, id, me))!,
          theirs: (await findConversationSummary(client, id, other))!,
        };
      }).catch((err) => {
        if (err instanceof DmExistsError) return undefined;
        throw err;
      });
      if (!created) {
        // A concurrent request created it first: its insert made ours wait for it to
        // commit, then do nothing.
        const id = (await findDirectConversationId(pool, userA, userB))!;
        return res.json({ conversation: await findConversationSummary(pool, id, me) });
      }

      // Right after COMMIT: both users' sockets join the room, and all their tabs are told.
      joinedConversation(io, me, created.mine);
      joinedConversation(io, other, created.theirs);
      res.status(201).json({ conversation: created.mine });
    } catch (err) {
      logger.error({ err }, 'Error opening a DM');
      next(new AppError(500, ErrorCode.INTERNAL_ERROR, 'Failed to open the conversation.'));
    }
  });

  return router;
}
