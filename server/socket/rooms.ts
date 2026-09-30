// server/socket/rooms.ts
// The Socket.io rooms of users and conversations (docs/v2-design.md §5). Every socket joins
// its user's room and the room of each conversation its user is a member of, when it
// connects (socketHandler.js). Membership changes then move all of that user's sockets at
// once, through the user's room, so the conversation rooms always match the memberships.
import type { Server } from 'socket.io';
import type { ConversationSummary } from '../repositories/conversations.js';

/** Every socket of one user: all their tabs and devices. */
export function userRoom(userId: number): string {
  return `user:${userId}`;
}

/** Every socket of a conversation's members: its messages and typing go here only. */
export function conversationRoom(conversationId: number): string {
  return `conv:${conversationId}`;
}

/** Whether a room is a conversation's. */
export function isConversationRoom(room: string): boolean {
  return room.startsWith('conv:');
}

// Counts the membership changes that have moved sockets. socketsJoin() and socketsLeave()
// cannot reach a socket that is still connecting, so a connecting socket compares this
// count before its membership lookup with the count once it is connected
// (socketHandler.js): a change in between means it must look again.
let membershipChanges = 0;

/** How many membership changes have moved sockets so far. */
export function membershipChangeCount(): number {
  return membershipChanges;
}

/**
 * Right after a membership is committed: puts every socket of the user in the
 * conversation's room, and tells all of them (conversation:joined), so every tab can add
 * it to its sidebar. Call it with no await since the COMMIT, so no message sent to the
 * conversation after it misses the user's sockets.
 */
export function joinedConversation(io: Server, userId: number, conversation: ConversationSummary): void {
  membershipChanges += 1;
  io.in(userRoom(userId)).socketsJoin(conversationRoom(conversation.id));
  io.to(userRoom(userId)).emit('conversation:joined', conversation);
}

/** After a membership is deleted: the user's sockets leave the room, and every tab is told (conversation:left). */
export function leftConversation(io: Server, userId: number, conversationId: number): void {
  membershipChanges += 1;
  io.in(userRoom(userId)).socketsLeave(conversationRoom(conversationId));
  io.to(userRoom(userId)).emit('conversation:left', { conversationId });
}
