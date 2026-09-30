// client/src/lib/chatState.ts
// The chat's state rules, apart from React: the sidebar's list of conversations and each
// conversation's messages (its "timeline"). ChatProvider (context/ChatProvider.jsx) keeps
// the state; these functions say how it changes. Framework-free, so
// client/test/chatState.test.js can run them under `node --test`.
//
// Shapes are the server's (server/repositories/conversations.ts and messages.ts), as JSON.

export interface Message {
  id: number;
  conversationId: number;
  seq: number;
  userId: number;
  username: string;
  content: string;
  createdAt: string;
}

export interface Conversation {
  id: number;
  type: 'channel' | 'dm';
  visibility: 'public' | 'private' | null;
  name: string;
  topic: string | null;
  role: 'owner' | 'admin' | 'member';
  lastSeq: number;
  lastReadSeq: number;
  unreadCount: number;
  lastMessageAt: string | null;
  lastActivityAt: string;
}

// ─── Conversations (the sidebar) ────────────────────────────────────────────────

/** In the server's order (GET /api/conversations): most recent activity first, then newest. */
export function sortConversations(list: Conversation[]): Conversation[] {
  return [...list].sort(
    (a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt) || b.id - a.id,
  );
}

/** Adds a conversation, or replaces the one with its id, keeping the order. */
export function upsertConversation(list: Conversation[], conversation: Conversation): Conversation[] {
  return sortConversations([...list.filter((c) => c.id !== conversation.id), conversation]);
}

export function removeConversation(list: Conversation[], conversationId: number): Conversation[] {
  return list.filter((c) => c.id !== conversationId);
}

/**
 * What a new message does to the sidebar: its conversation's latest seq and activity move
 * forward, and it is unread unless I sent it (the server marks my own messages read).
 * A message the list has no conversation for changes nothing.
 */
export function applyMessage(list: Conversation[], message: Message, myUserId: number): Conversation[] {
  const conversation = list.find((c) => c.id === message.conversationId);
  if (!conversation) return list;
  const lastSeq = Math.max(conversation.lastSeq, message.seq);
  const lastReadSeq = message.userId === myUserId ? Math.max(conversation.lastReadSeq, message.seq) : conversation.lastReadSeq;
  const later = (a: string | null, b: string) => (a !== null && Date.parse(a) > Date.parse(b) ? a : b);
  return upsertConversation(list, {
    ...conversation,
    lastSeq,
    lastReadSeq,
    unreadCount: lastSeq - lastReadSeq,
    lastMessageAt: later(conversation.lastMessageAt, message.createdAt),
    lastActivityAt: later(conversation.lastActivityAt, message.createdAt),
  });
}

/** Marks a conversation read up to `seq`, as the server does: never back, never past lastSeq. */
export function markReadLocally(list: Conversation[], conversationId: number, seq: number): Conversation[] {
  return list.map((c) => {
    if (c.id !== conversationId) return c;
    const lastReadSeq = Math.max(c.lastReadSeq, Math.min(seq, c.lastSeq));
    return { ...c, lastReadSeq, unreadCount: c.lastSeq - lastReadSeq };
  });
}

/** Where /chat remembers the conversation a user last had open (per user: browsers are shared). */
export function lastConversationKey(userId: number): string {
  return `relay_last_conversation:${userId}`;
}

/** #general, the public channel everyone is in (a private channel may have the same name). */
export function findGeneral(list: Conversation[]): Conversation | undefined {
  return list.find((c) => c.type === 'channel' && c.visibility === 'public' && c.name === 'general');
}

/**
 * Whether I may leave a conversation, by the server's rules (server/routes/conversations.ts):
 * any channel but #general, except a private channel I own; never a DM.
 */
export function canLeave(conversation: Conversation): boolean {
  if (conversation.type === 'dm') return false;
  if (conversation.visibility === 'public') return conversation.name !== 'general';
  return conversation.role !== 'owner';
}

// ─── Timelines (each conversation's messages) ───────────────────────────────────

export interface Timeline {
  /** Oldest first, by seq, each id once. */
  messages: Message[];
  status: 'loading' | 'ready' | 'error';
  loadingOlder: boolean;
}

export type Timelines = Record<number, Timeline>;

export type TimelineAction =
  | { type: 'loading'; conversationId: number }
  | { type: 'latestLoaded'; conversationId: number; messages: Message[] }
  | { type: 'failed'; conversationId: number }
  | { type: 'loadingOlder'; conversationId: number }
  | { type: 'olderLoaded'; conversationId: number; messages: Message[] }
  | { type: 'olderFailed'; conversationId: number }
  | { type: 'received'; message: Message }
  | { type: 'forget'; conversationId: number }
  | { type: 'keepOnly'; conversationId: number | null };

/** Both lists together, each message once (by id), oldest first by seq. */
export function mergeMessages(existing: Message[], incoming: Message[]): Message[] {
  const byId = new Map(existing.map((m) => [m.id, m]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

/**
 * The latest page of history together with what is known. When the page does not connect
 * to what is known (many messages came while this tab was offline), what is older than
 * the page is dropped, so the timeline never has a hole; it loads again on demand.
 */
export function withLatestPage(known: Message[], latest: Message[]): Message[] {
  if (latest.length === 0 || known.length === 0) return mergeMessages(known, latest);
  const first = latest[0].seq;
  const last = latest[latest.length - 1].seq;
  const connects = first === 1 || known.some((m) => m.seq === first - 1);
  return mergeMessages(connects ? known : known.filter((m) => m.seq > last), latest);
}

/** Whether older messages exist: seqs are gapless from 1, so the first one loaded says. */
export function hasOlder(timeline: Timeline | undefined): boolean {
  return !!timeline && timeline.messages.length > 0 && timeline.messages[0].seq > 1;
}

export function timelinesReducer(state: Timelines, action: TimelineAction): Timelines {
  switch (action.type) {
    case 'loading': {
      const current = state[action.conversationId];
      // Keep what is shown while it reloads (a reconnect); an unknown one starts empty.
      return { ...state, [action.conversationId]: current ?? { messages: [], status: 'loading', loadingOlder: false } };
    }
    case 'latestLoaded': {
      // What is known already: an earlier load, and live messages received while loading.
      const known = state[action.conversationId]?.messages ?? [];
      const latest = action.messages;
      return {
        ...state,
        [action.conversationId]: { messages: withLatestPage(known, latest), status: 'ready', loadingOlder: false },
      };
    }
    case 'failed': {
      const current = state[action.conversationId];
      // A failed reload keeps what was shown; a first load shows the error.
      if (current?.status === 'ready' && current.messages.length > 0) return state;
      return { ...state, [action.conversationId]: { messages: [], status: 'error', loadingOlder: false } };
    }
    case 'loadingOlder':
    case 'olderFailed': {
      const current = state[action.conversationId];
      if (!current) return state;
      return { ...state, [action.conversationId]: { ...current, loadingOlder: action.type === 'loadingOlder' } };
    }
    case 'olderLoaded': {
      const current = state[action.conversationId];
      if (!current) return state;
      return {
        ...state,
        [action.conversationId]: { ...current, messages: mergeMessages(current.messages, action.messages), loadingOlder: false },
      };
    }
    case 'received': {
      // Into a timeline that is loaded or loading (the page may not have it: it may have
      // been read before the message was sent). Another one loads it with its history.
      const current = state[action.message.conversationId];
      if (!current || current.status === 'error') return state;
      return {
        ...state,
        [action.message.conversationId]: { ...current, messages: mergeMessages(current.messages, [action.message]) },
      };
    }
    case 'forget': {
      const next = { ...state };
      delete next[action.conversationId];
      return next;
    }
    case 'keepOnly': {
      // After a reconnect: others may have missed messages, so they load again when opened.
      if (action.conversationId === null || !state[action.conversationId]) return {};
      return { [action.conversationId]: state[action.conversationId] };
    }
    default:
      return state;
  }
}
