// server/socket/socketHandler.js
import jwt  from 'jsonwebtoken';
import { config } from '../config/env.js';
import { withTransaction } from '../db/transaction.js';
import { logger } from '../lib/logger.js';
import { allocateSeq, findGeneralId } from '../repositories/conversations.js';
import { createMessage } from '../repositories/messages.js';

export default function socketHandler(io) {

  // Tracks per-user typing timeout so the server can auto-clear after 3 s.
  // Key: user.id  →  Value: setTimeout handle
  const typingTimers = new Map();

  // ── Auth middleware ────────────────────────────────────────────────────────
  // Runs before every connection is accepted.
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;

    if (!token) {
      return next(new Error('Authentication error: no token provided'));
    }

    try {
      const decoded = jwt.verify(token, config.jwtSecret);
      socket.user = decoded; // shape: { id, username, iat, exp }
      next();
    } catch {
      return next(new Error('Authentication error: invalid or expired token'));
    }
  });

  // ── Connection handler ─────────────────────────────────────────────────────
  io.on('connection', (socket) => {
    // Every log line for this connection carries who it is.
    const log = logger.child({ socketId: socket.id, userId: socket.user.id, username: socket.user.username });
    log.info('Socket connected');

    // Tell everyone the new count (including the arriving user).
    io.emit('online_count', io.sockets.sockets.size);

    // ── new_message ────────────────────────────────────────────────────────
    socket.on('new_message', async ({ content } = {}) => {
      if (!content || typeof content !== 'string' || !content.trim()) return;

      try {
        // Everything goes to #general for now. allocateSeq() locks #general's row
        // until COMMIT, so concurrent sends get consecutive seqs in commit order.
        const message = await withTransaction(async (client) => {
          const conversationId = await findGeneralId(client);
          const seq = await allocateSeq(client, conversationId);
          return createMessage(client, { conversationId, seq, authorId: socket.user.id, content: content.trim() });
        });

        // Only after COMMIT: broadcast to ALL connected clients (including the sender
        // so their message appears in the same pipeline as everyone else's).
        io.emit('message', message);
      } catch (err) {
        log.error({ err }, 'DB error saving message');
        // Only tell the sender — don't crash the whole server.
        socket.emit('error', { message: 'Failed to save message.' });
      }
    });

    // ── typing ─────────────────────────────────────────────────────────────
    // The client emits this on every keystroke; the server debounces it so
    // only one broadcast fires per burst, then auto-clears after 3 s of silence.
    socket.on('typing', () => {
      if (!typingTimers.has(socket.user.id)) {
        // First event in this burst — let everyone else know.
        socket.broadcast.emit('user_typing', socket.user.username);
      }

      // Reset (or start) the auto-clear countdown.
      clearTimeout(typingTimers.get(socket.user.id));
      typingTimers.set(
        socket.user.id,
        setTimeout(() => {
          socket.broadcast.emit('user_stop_typing', socket.user.username);
          typingTimers.delete(socket.user.id);
        }, 3000)
      );
    });

    // ── Disconnect ─────────────────────────────────────────────────────────
    socket.on('disconnect', (reason) => {
      log.info({ reason }, 'Socket disconnected');

      // If the user was mid-typing, cancel the timer and clear the indicator.
      if (typingTimers.has(socket.user.id)) {
        clearTimeout(typingTimers.get(socket.user.id));
        typingTimers.delete(socket.user.id);
        socket.broadcast.emit('user_stop_typing', socket.user.username);
      }

      // Emit the *updated* size after this socket is removed.
      io.emit('online_count', io.sockets.sockets.size);
    });
  });
}
