// server/socket/sessionSweep.ts
import type { Server } from 'socket.io';
import pool from '../db/connection.js';
import { SESSION_SWEEP_INTERVAL_MS } from '../lib/limits.js';
import { logger } from '../lib/logger.js';
import { SESSION_ROOM_PREFIX, sessionRoom } from '../lib/sessions.js';
import { deleteEndedSessions, findValidSessions } from '../repositories/sessions.js';

/**
 * Cleans up after sessions that ended without a logout (audit §7.8): disconnects the
 * sockets of sessions that were deleted, expired or went idle, and deletes ended session
 * rows. An open socket counts as use, so its session's last_seen_at moves forward:
 * someone who only chats over the socket is not idled out.
 */
export async function sweepSessions(io: Server): Promise<void> {
  // The connected sessions are the session rooms (lib/sessions.ts); one query checks them all.
  const connected = [...io.sockets.adapter.rooms.keys()]
    .filter((room) => room.startsWith(SESSION_ROOM_PREFIX))
    .map((room) => Buffer.from(room.slice(SESSION_ROOM_PREFIX.length), 'hex'));

  let disconnected = 0;
  if (connected.length > 0) {
    const valid = new Set((await findValidSessions(pool, connected)).map((hash) => hash.toString('hex')));
    for (const tokenHash of connected) {
      if (valid.has(tokenHash.toString('hex'))) continue;
      io.in(sessionRoom(tokenHash)).disconnectSockets(true);
      disconnected += 1;
    }
  }

  // After the check above, which keeps connected sessions from counting as idle.
  const deleted = await deleteEndedSessions(pool);

  if (disconnected > 0 || deleted > 0) {
    logger.info({ disconnectedSessions: disconnected, deletedSessions: deleted }, 'Session sweep');
  }
}

/**
 * Runs sweepSessions every SESSION_SWEEP_INTERVAL_MS. The timer is unref'd, so it never
 * keeps the process alive. stop() clears it and waits for a sweep in progress, so the
 * shutdown sequence can close the pool after it.
 */
export function startSessionSweep(io: Server) {
  let running: Promise<void> | undefined;

  const timer = setInterval(() => {
    if (running) return; // the previous sweep has not finished (e.g. a slow database)
    running = sweepSessions(io)
      .catch((err) => logger.error({ err }, 'Session sweep failed'))
      .finally(() => {
        running = undefined;
      });
  }, SESSION_SWEEP_INTERVAL_MS);
  timer.unref();

  return {
    async stop(): Promise<void> {
      clearInterval(timer);
      await running;
    },
  };
}
