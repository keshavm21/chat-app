// server/routes/conversations.ts
import express from 'express';
import type { Server } from 'socket.io';
import pool from '../db/connection.js';
import { withTransaction } from '../db/transaction.js';
import { conversationNotFound, requireMember } from '../http/requireMember.js';
import { requireSession } from '../http/requireSession.js';
import { addMemberSchema, markReadSchema, messagesQuerySchema, validationError } from '../http/schemas.js';
import { AppError, ErrorCode } from '../lib/errors.js';
import { parseId } from '../lib/ids.js';
import { MESSAGE_PAGE_SIZE } from '../lib/limits.js';
import { logger } from '../lib/logger.js';
import {
  addMember,
  findConversationSummary,
  GENERAL_CHANNEL,
  joinPublicChannel,
  listConversations,
  markRead,
  removeMember,
} from '../repositories/conversations.js';
import { listMessages } from '../repositories/messages.js';
import { findUserByUsername } from '../repositories/users.js';
import { joinedConversation, leftConversation } from '../socket/rooms.js';

/**
 * The /api/conversations routes: my conversations, and each one's messages, read position
 * and members. They take `io`, because joining, leaving and adding a member move sockets
 * between conversation rooms (socket/rooms.ts). Reading needs membership (D14); anyone
 * else gets 404, as if the conversation did not exist (http/requireMember.ts).
 */
export default function conversationRoutes(io: Server) {
  const router = express.Router();
  router.use(requireSession);

  // ─── GET /api/conversations ──────────────────────────────────────────────────
  // My channels and DMs with their unread counts, the most recently active first.
  router.get('/', async (req, res, next) => {
    try {
      res.json({ conversations: await listConversations(pool, req.user!.id) });
    } catch (err) {
      logger.error({ err }, 'Error listing conversations');
      next(new AppError(500, ErrorCode.INTERNAL_ERROR, 'Failed to load conversations.'));
    }
  });

  // ─── GET /api/conversations/:id/messages?before=&limit= ──────────────────────
  // A page of history, oldest first: the latest `limit` messages, or the latest before
  // seq `before` ("load older"). Older messages exist while the first one's seq is above 1.
  router.get('/:id/messages', requireMember, async (req, res, next) => {
    const parsed = messagesQuerySchema.safeParse(req.query);
    if (!parsed.success) return next(validationError(parsed.error));
    const { before, limit = MESSAGE_PAGE_SIZE } = parsed.data;

    try {
      res.json({ messages: await listMessages(pool, req.membership!.conversationId, { before, limit }) });
    } catch (err) {
      logger.error({ err }, 'Error fetching messages');
      next(new AppError(500, ErrorCode.INTERNAL_ERROR, 'Failed to fetch messages.'));
    }
  });

  // ─── PUT /api/conversations/:id/read ─────────────────────────────────────────
  // Moves my read position forward to `seq` (never back, never past the last message).
  router.put('/:id/read', requireMember, async (req, res, next) => {
    const parsed = markReadSchema.safeParse(req.body);
    if (!parsed.success) return next(validationError(parsed.error));

    try {
      await markRead(pool, req.membership!.conversationId, req.user!.id, parsed.data.seq);
      res.status(204).end();
    } catch (err) {
      logger.error({ err }, 'Error marking a conversation read');
      next(new AppError(500, ErrorCode.INTERNAL_ERROR, 'Failed to mark the conversation as read.'));
    }
  });

  // ─── POST /api/conversations/:id/join ────────────────────────────────────────
  // Joins a public channel. Joining one I am already in changes nothing; anything else I
  // cannot join (a private channel, a DM, no such conversation) is a 404.
  router.post('/:id/join', async (req, res, next) => {
    const conversationId = parseId(req.params.id);
    if (conversationId === undefined) return next(conversationNotFound());
    const userId = req.user!.id;

    try {
      const { joined, conversation } = await withTransaction(async (client) => ({
        joined: await joinPublicChannel(client, conversationId, userId),
        conversation: await findConversationSummary(client, conversationId, userId),
      }));
      if (!conversation) return next(conversationNotFound());

      // Right after COMMIT, before anything else can run: no message misses the user's sockets.
      if (joined) joinedConversation(io, userId, conversation);
      res.json({ conversation });
    } catch (err) {
      logger.error({ err }, 'Error joining a channel');
      next(new AppError(500, ErrorCode.INTERNAL_ERROR, 'Failed to join the channel.'));
    }
  });

  // ─── POST /api/conversations/:id/leave ───────────────────────────────────────
  // Leaves a channel: any public one but #general, which everyone stays in, and a private
  // one unless I own it (its owner is the only one who can add members, and there is no
  // ownership transfer). DMs cannot be left.
  router.post('/:id/leave', requireMember, async (req, res, next) => {
    const { conversationId, type, visibility, name, role } = req.membership!;
    if (type === 'dm') {
      return next(new AppError(403, ErrorCode.FORBIDDEN, 'Direct messages cannot be left.'));
    }
    if (visibility === 'public' && name === GENERAL_CHANNEL) {
      return next(new AppError(403, ErrorCode.FORBIDDEN, 'You cannot leave #general.'));
    }
    if (visibility === 'private' && role === 'owner') {
      return next(new AppError(403, ErrorCode.FORBIDDEN, 'The owner cannot leave a private channel.'));
    }

    try {
      await removeMember(pool, conversationId, req.user!.id);
      // At once: the user's sockets leave the room, so nothing more reaches them. REST and
      // sends check the membership, which is already gone.
      leftConversation(io, req.user!.id, conversationId);
      res.status(204).end();
    } catch (err) {
      logger.error({ err }, 'Error leaving a channel');
      next(new AppError(500, ErrorCode.INTERNAL_ERROR, 'Failed to leave the channel.'));
    }
  });

  // ─── POST /api/conversations/:id/members ─────────────────────────────────────
  // The owner of a private channel adds someone by username. Adding a member again
  // changes nothing.
  router.post('/:id/members', requireMember, async (req, res, next) => {
    const { conversationId, type, visibility, role } = req.membership!;
    if (type !== 'channel' || visibility !== 'private' || role !== 'owner') {
      return next(new AppError(403, ErrorCode.FORBIDDEN, 'Only the owner of a private channel can add members.'));
    }
    const parsed = addMemberSchema.safeParse(req.body);
    if (!parsed.success) return next(validationError(parsed.error));

    try {
      const user = await findUserByUsername(pool, parsed.data.username);
      if (!user) return next(new AppError(404, ErrorCode.NOT_FOUND, 'User not found.'));

      const added = await withTransaction(async (client) =>
        (await addMember(client, conversationId, user.id, 'member'))
          ? findConversationSummary(client, conversationId, user.id)
          : undefined,
      );
      // Right after COMMIT: the new member's sockets join the room, and their tabs are told.
      if (added) joinedConversation(io, user.id, added);
      res.status(204).end();
    } catch (err) {
      logger.error({ err }, 'Error adding a member');
      next(new AppError(500, ErrorCode.INTERNAL_ERROR, 'Failed to add the member.'));
    }
  });

  return router;
}
