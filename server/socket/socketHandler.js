// server/socket/socketHandler.js
import pool from '../db/connection.js';
import { withTransaction } from '../db/transaction.js';
import { isId } from '../lib/ids.js';
import { MESSAGE_MAX_LENGTH } from '../lib/limits.js';
import { logger } from '../lib/logger.js';
import { hashSessionToken, sessionCookie, sessionRoom } from '../lib/sessions.js';
import { allocateSeq, listMemberConversationIds, markRead } from '../repositories/conversations.js';
import { createMessage } from '../repositories/messages.js';
import { findSessionUser } from '../repositories/sessions.js';
import { conversationRoom, isConversationRoom, membershipChangeCount, userRoom } from './rooms.js';

// How long after a user's last `typing` event in a conversation their indicator is cleared.
const TYPING_TIMEOUT_MS = 3000;

// Thrown inside the send transaction to roll it back when the sender is not a member
// (or the conversation does not exist: the sender is told the same, so nothing leaks).
class NotAMemberError extends Error {}

export default function socketHandler(io) {

  // ── Auth middleware ────────────────────────────────────────────────────────
  // Runs before every connection is accepted: the browser sends the session cookie
  // with the handshake. The client logs out on a connect_error whose message
  // contains "Authentication", so only a missing or invalid session may say that.
  io.use(async (socket, next) => {
    const token = sessionCookie.read(socket.handshake.headers.cookie);

    if (!token) {
      return next(new Error('Authentication error: no token provided'));
    }

    const sessionHash = hashSessionToken(token);
    let user;
    try {
      user = await findSessionUser(pool, sessionHash);
    } catch (err) {
      logger.error({ err }, 'Socket session lookup failed');
      return next(new Error('Server error: could not check the session'));
    }
    if (!user) {
      return next(new Error('Authentication error: invalid or expired token'));
    }

    // The user's conversations, whose rooms the socket joins as soon as it connects.
    const changesBefore = membershipChangeCount();
    let conversationIds;
    try {
      conversationIds = await listMemberConversationIds(pool, user.id);
    } catch (err) {
      logger.error({ err }, 'Socket conversation lookup failed');
      return next(new Error('Server error: could not load your conversations'));
    }

    socket.user = { id: user.id, username: user.username };
    socket.sessionHash = sessionHash;
    socket.conversationIds = conversationIds;
    socket.membershipChangesBefore = changesBefore;
    next();
  });

  // ── Connection handler ─────────────────────────────────────────────────────
  io.on('connection', (socket) => {
    // Every log line for this connection carries who it is.
    const log = logger.child({ socketId: socket.id, userId: socket.user.id, username: socket.user.username });
    log.info('Socket connected');

    // The rooms are joined here, synchronously, in the same tick in which Socket.io
    // registered the socket and sent it `connect`: no broadcast can run in between, so
    // by the time the client sees `connect`, it misses nothing.
    // - session: ending the session disconnects all of its sockets (logout, the sweep);
    // - user: membership changes move all of the user's sockets between rooms (rooms.ts);
    // - each conversation: its messages and typing go to its members only.
    // From here on, membership changes reach this socket through its user's room.
    socket.join([
      sessionRoom(socket.sessionHash),
      userRoom(socket.user.id),
      ...socket.conversationIds.map(conversationRoom),
    ]);
    // A membership that changed while the socket was connecting (after the middleware's
    // lookup, before this point) moved no rooms for it: socketsJoin() and socketsLeave()
    // cannot reach a socket that is not connected yet. Then look again, now that later
    // changes do reach it; and again if another change came during that lookup, since
    // its result could then undo that change (a leave, say).
    const syncRooms = async () => {
      for (;;) {
        const changesBefore = membershipChangeCount();
        const ids = await listMemberConversationIds(pool, socket.user.id);
        if (!socket.connected) return;
        if (membershipChangeCount() !== changesBefore) continue;
        const current = new Set(ids.map(conversationRoom));
        for (const room of socket.rooms) {
          if (isConversationRoom(room) && !current.has(room)) socket.leave(room);
        }
        socket.join([...current]);
        return;
      }
    };
    if (membershipChangeCount() !== socket.membershipChangesBefore) {
      syncRooms().catch((err) => log.error({ err }, 'Socket conversation lookup failed'));
    }
    delete socket.conversationIds;
    delete socket.membershipChangesBefore;

    // Tell everyone the new count (including the arriving user).
    io.emit('online_count', io.sockets.sockets.size);

    // ── new_message ────────────────────────────────────────────────────────
    // The payload is whatever the client sent (possibly null): never destructure it.
    socket.on('new_message', async (payload) => {
      const conversationId = payload?.conversationId;
      const content = payload?.content;
      if (!isId(conversationId) || typeof content !== 'string') return;
      const text = content.trim();
      if (!text) return; // empty messages are ignored
      // Counted in characters (code points), as the database's char_length() does.
      if ([...text].length > MESSAGE_MAX_LENGTH) {
        socket.emit('error', { message: `Message is too long (maximum ${MESSAGE_MAX_LENGTH} characters).` });
        return;
      }

      try {
        // allocateSeq() locks the conversation's row until COMMIT, so concurrent sends
        // get consecutive seqs in commit order.
        const message = await withTransaction(async (client) => {
          const seq = await allocateSeq(client, conversationId);
          if (seq === undefined) throw new NotAMemberError(); // no such conversation
          const created = await createMessage(client, { conversationId, seq, authorId: socket.user.id, content: text });
          // Not a member: roll back, which also gives the seq back, so it leaves no gap.
          if (!created) throw new NotAMemberError();
          // The sender has read everything up to their own message.
          await markRead(client, conversationId, socket.user.id, seq);
          return created;
        });

        // Only after COMMIT: to the conversation's members, the sender included, so
        // their message appears in the same pipeline as everyone else's.
        io.to(conversationRoom(conversationId)).emit('message', message);
      } catch (err) {
        if (err instanceof NotAMemberError) {
          log.warn({ conversationId }, 'Message rejected: the sender is not a member');
          socket.emit('error', { message: 'You are not a member of this conversation.' });
          return;
        }
        log.error({ err }, 'DB error saving message');
        // Only tell the sender — don't crash the whole server.
        socket.emit('error', { message: 'Failed to save message.' });
      }
    });

    // ── typing ─────────────────────────────────────────────────────────────
    // The client emits this on every keystroke; the server debounces it so only one
    // `user_typing` goes out per burst, and `user_stop_typing` after 3 s of silence.
    // The timers are this socket's own (conversationId → timer), so another tab
    // disconnecting never clears this one's indicator.
    const typingTimers = new Map();
    const typing = (conversationId) => ({ conversationId, username: socket.user.username });
    // The conversation's members, except the typist in any of their tabs.
    const othersIn = (conversationId) => io.to(conversationRoom(conversationId)).except(userRoom(socket.user.id));

    socket.on('typing', (payload) => {
      const conversationId = payload?.conversationId;
      // Members only: the socket's rooms are its user's memberships.
      if (!isId(conversationId) || !socket.rooms.has(conversationRoom(conversationId))) return;

      if (!typingTimers.has(conversationId)) {
        // First event in this burst — let the others know.
        othersIn(conversationId).emit('user_typing', typing(conversationId));
      }

      // Reset (or start) the auto-clear countdown.
      clearTimeout(typingTimers.get(conversationId));
      typingTimers.set(
        conversationId,
        setTimeout(() => {
          typingTimers.delete(conversationId);
          othersIn(conversationId).emit('user_stop_typing', typing(conversationId));
        }, TYPING_TIMEOUT_MS),
      );
    });

    // ── Disconnect ─────────────────────────────────────────────────────────
    socket.on('disconnect', (reason) => {
      log.info({ reason }, 'Socket disconnected');

      // If the user was mid-typing, cancel the timers and clear the indicators.
      for (const [conversationId, timer] of typingTimers) {
        clearTimeout(timer);
        othersIn(conversationId).emit('user_stop_typing', typing(conversationId));
      }
      typingTimers.clear();

      // Emit the *updated* size after this socket is removed.
      io.emit('online_count', io.sockets.sockets.size);
    });
  });
}
