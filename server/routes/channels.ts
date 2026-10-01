// server/routes/channels.ts
import express from 'express';
import type { Server } from 'socket.io';
import pool from '../db/connection.js';
import { withTransaction } from '../db/transaction.js';
import type { createRateLimiters } from '../http/rateLimits.js';
import { requireSession } from '../http/requireSession.js';
import { createChannelSchema, searchQuerySchema, validationError } from '../http/schemas.js';
import { AppError, ErrorCode } from '../lib/errors.js';
import { CHANNEL_LIST_LIMIT } from '../lib/limits.js';
import { logger } from '../lib/logger.js';
import { addMember, createChannel, findConversationSummary, listPublicChannels } from '../repositories/conversations.js';
import { joinedConversation } from '../socket/rooms.js';

const PG_UNIQUE_VIOLATION = '23505';

/**
 * The /api/channels routes: browsing public channels and creating channels. They take
 * `io`, because the creator's sockets join the new channel's room, and the app's rate
 * limiters (http/rateLimits.ts): channel creation is limited per user.
 */
export default function channelRoutes(io: Server, rateLimiters: ReturnType<typeof createRateLimiters>) {
  const router = express.Router();
  router.use(requireSession);

  // ─── GET /api/channels?q= ────────────────────────────────────────────────────
  // Public channels whose name starts with `q` (all of them without it), by name, and
  // whether I am a member. Private channels are never listed.
  router.get('/', async (req, res, next) => {
    const parsed = searchQuerySchema.safeParse(req.query);
    if (!parsed.success) return next(validationError(parsed.error));

    try {
      res.json({ channels: await listPublicChannels(pool, req.user!.id, parsed.data.q, CHANNEL_LIST_LIMIT) });
    } catch (err) {
      logger.error({ err }, 'Error listing channels');
      next(new AppError(500, ErrorCode.INTERNAL_ERROR, 'Failed to load channels.'));
    }
  });

  // ─── POST /api/channels ──────────────────────────────────────────────────────
  // Creates a channel (public unless `visibility` says private), with its creator as its
  // owner and first member.
  router.post('/', rateLimiters.channelCreation, async (req, res, next) => {
    const parsed = createChannelSchema.safeParse(req.body);
    if (!parsed.success) return next(validationError(parsed.error));
    const userId = req.user!.id;

    try {
      const conversation = await withTransaction(async (client) => {
        const id = await createChannel(client, { ...parsed.data, createdBy: userId });
        await addMember(client, id, userId, 'owner');
        return (await findConversationSummary(client, id, userId))!;
      });

      // Right after COMMIT: the creator's sockets join the room, and their other tabs are told.
      joinedConversation(io, userId, conversation);
      res.status(201).json({ conversation });
    } catch (err) {
      // Public channels' names are unique (migration 0004); private ones are not, so this
      // never reveals a private channel. The constraint decides, so two requests for the
      // same name cannot both succeed.
      const { code, constraint } = err as { code?: string; constraint?: string };
      if (code === PG_UNIQUE_VIOLATION && constraint === 'conversations_public_channel_name_key') {
        return next(new AppError(409, ErrorCode.CONFLICT, 'A channel with that name already exists.'));
      }
      logger.error({ err }, 'Error creating a channel');
      next(new AppError(500, ErrorCode.INTERNAL_ERROR, 'Failed to create the channel.'));
    }
  });

  return router;
}
