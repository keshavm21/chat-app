// The chat's state rules (src/lib/chatState.ts), under Node's own test runner (`npm test`).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyMessage,
  canLeave,
  findGeneral,
  hasOlder,
  markReadLocally,
  mergeMessages,
  removeConversation,
  sortConversations,
  timelinesReducer,
  upsertConversation,
  withLatestPage,
} from '../src/lib/chatState.ts';

const ME = 1;

function conversation(id, overrides = {}) {
  return {
    id,
    type: 'channel',
    visibility: 'public',
    name: `channel-${id}`,
    topic: null,
    role: 'member',
    lastSeq: 0,
    lastReadSeq: 0,
    unreadCount: 0,
    lastMessageAt: null,
    lastActivityAt: '2026-10-01T10:00:00.000Z',
    ...overrides,
  };
}

function message(seq, overrides = {}) {
  return {
    id: 1000 + seq,
    conversationId: 7,
    seq,
    userId: 2,
    username: 'bob',
    content: `message ${seq}`,
    createdAt: `2026-10-01T11:00:${String(seq % 60).padStart(2, '0')}.000Z`,
    ...overrides,
  };
}

const seqs = (messages) => messages.map((m) => m.seq);
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => message(from + i));

describe('the conversation list', () => {
  it('sorts by last activity, then the newest id first, as the server does', () => {
    const list = [
      conversation(1, { lastActivityAt: '2026-10-01T09:00:00.000Z' }),
      conversation(2, { lastActivityAt: '2026-10-01T12:00:00.000Z' }),
      conversation(3, { lastActivityAt: '2026-10-01T09:00:00.000Z' }),
    ];
    assert.deepEqual(sortConversations(list).map((c) => c.id), [2, 3, 1]);
  });

  it('adds or replaces a conversation by id, and removes one', () => {
    const list = [conversation(1), conversation(2)];
    const replaced = upsertConversation(list, conversation(1, { name: 'renamed' }));
    assert.deepEqual(replaced.map((c) => c.name).sort(), ['channel-2', 'renamed']);
    assert.equal(upsertConversation(list, conversation(3)).length, 3);
    assert.deepEqual(removeConversation(list, 1).map((c) => c.id), [2]);
  });

  it("counts another user's message as unread and moves its conversation to the top", () => {
    const list = [conversation(7, { lastActivityAt: '2026-10-01T09:00:00.000Z' }), conversation(8)];
    const next = applyMessage(list, message(3), ME);

    assert.equal(next[0].id, 7);
    assert.deepEqual(
      { lastSeq: next[0].lastSeq, lastReadSeq: next[0].lastReadSeq, unreadCount: next[0].unreadCount },
      { lastSeq: 3, lastReadSeq: 0, unreadCount: 3 },
    );
    assert.equal(next[0].lastMessageAt, message(3).createdAt);
    assert.equal(next[0].lastActivityAt, message(3).createdAt);
  });

  it('counts my own message as read, like the server', () => {
    const list = [conversation(7, { lastSeq: 2, unreadCount: 2 })];
    const [next] = applyMessage(list, message(3, { userId: ME }), ME);
    assert.deepEqual([next.lastSeq, next.lastReadSeq, next.unreadCount], [3, 3, 0]);
  });

  it('ignores a message for a conversation it does not have, and never moves counters back', () => {
    const list = [conversation(7, { lastSeq: 5, lastReadSeq: 5 })];
    assert.equal(applyMessage(list, message(1, { conversationId: 99 }), ME), list);
    const [next] = applyMessage(list, message(4), ME); // an old message arriving late
    assert.deepEqual([next.lastSeq, next.unreadCount], [5, 0]);
  });

  it('marks read never backwards and never past the last message', () => {
    const list = [conversation(7, { lastSeq: 5, lastReadSeq: 2, unreadCount: 3 })];
    assert.deepEqual(markReadLocally(list, 7, 4)[0].unreadCount, 1);
    assert.deepEqual(markReadLocally(list, 7, 1)[0].lastReadSeq, 2);
    const [past] = markReadLocally(list, 7, 99);
    assert.deepEqual([past.lastReadSeq, past.unreadCount], [5, 0]);
  });

  it('lets me leave any channel but #general, except a private one I own, and never a DM', () => {
    assert.equal(canLeave(conversation(1)), true);
    assert.equal(canLeave(conversation(1, { name: 'general' })), false);
    assert.equal(canLeave(conversation(1, { name: 'general', visibility: 'private' })), true);
    assert.equal(canLeave(conversation(1, { visibility: 'private', role: 'owner' })), false);
    assert.equal(canLeave(conversation(1, { role: 'owner' })), true);
    assert.equal(canLeave(conversation(1, { type: 'dm', visibility: null })), false);
  });

  it('finds #general, not a private channel of the same name', () => {
    const list = [conversation(1, { name: 'general', visibility: 'private' }), conversation(2, { name: 'general' })];
    assert.equal(findGeneral(list).id, 2);
  });
});

describe('timelines', () => {
  const ready = (messages) => ({ 7: { messages, status: 'ready', loadingOlder: false } });

  it('merges messages by id, oldest first, each once', () => {
    const merged = mergeMessages([message(2), message(3)], [message(3), message(1), message(4)]);
    assert.deepEqual(seqs(merged), [1, 2, 3, 4]);
  });

  it('loads the latest page, and knows whether older messages exist', () => {
    let state = timelinesReducer({}, { type: 'loading', conversationId: 7 });
    assert.equal(state[7].status, 'loading');
    state = timelinesReducer(state, { type: 'latestLoaded', conversationId: 7, messages: range(51, 100) });
    assert.equal(state[7].status, 'ready');
    assert.equal(hasOlder(state[7]), true);
    assert.equal(hasOlder(ready(range(1, 50))[7]), false);
    assert.equal(hasOlder(ready([])[7]), false);
  });

  it('keeps a live message that arrives while the page is loading, even if the page lacks it', () => {
    let state = timelinesReducer({}, { type: 'loading', conversationId: 7 });
    state = timelinesReducer(state, { type: 'received', message: message(11) });
    state = timelinesReducer(state, { type: 'latestLoaded', conversationId: 7, messages: range(1, 10) });
    assert.deepEqual(seqs(state[7].messages), range(1, 11).map((m) => m.seq));
  });

  it('merges a reconnect reload without duplicates when it connects to what is known', () => {
    const state = timelinesReducer(ready(range(1, 60)), { type: 'latestLoaded', conversationId: 7, messages: range(21, 70) });
    assert.deepEqual(seqs(state[7].messages), range(1, 70).map((m) => m.seq));
  });

  it('drops what is older than a reload that leaves a gap, so the timeline has no hole', () => {
    // Known: 1–50 and a live 200 received meanwhile; the reload is 151–200.
    const known = [...range(1, 50), message(200)];
    const state = timelinesReducer(ready(known), { type: 'latestLoaded', conversationId: 7, messages: range(151, 200) });
    assert.deepEqual(seqs(state[7].messages), range(151, 200).map((m) => m.seq));
    assert.equal(hasOlder(state[7]), true);
  });

  it('prepends older pages', () => {
    let state = timelinesReducer(ready(range(51, 100)), { type: 'loadingOlder', conversationId: 7 });
    assert.equal(state[7].loadingOlder, true);
    state = timelinesReducer(state, { type: 'olderLoaded', conversationId: 7, messages: range(1, 50) });
    assert.deepEqual([state[7].messages.length, state[7].loadingOlder, hasOlder(state[7])], [100, false, false]);
  });

  it('adds live messages to loaded timelines only, once each', () => {
    let state = timelinesReducer(ready(range(1, 2)), { type: 'received', message: message(3) });
    state = timelinesReducer(state, { type: 'received', message: message(3) });
    assert.deepEqual(seqs(state[7].messages), [1, 2, 3]);
    assert.equal(timelinesReducer(state, { type: 'received', message: message(1, { conversationId: 8 }) }), state);
  });

  it('keeps what is shown when a reload fails, and shows the error when a first load does', () => {
    const shown = ready(range(1, 3));
    assert.equal(timelinesReducer(shown, { type: 'failed', conversationId: 7 }), shown);
    const first = timelinesReducer(timelinesReducer({}, { type: 'loading', conversationId: 7 }), { type: 'failed', conversationId: 7 });
    assert.equal(first[7].status, 'error');
  });

  it('forgets a conversation, or all but the open one after a reconnect', () => {
    const state = { ...ready(range(1, 2)), 8: { messages: [], status: 'ready', loadingOlder: false } };
    assert.deepEqual(Object.keys(timelinesReducer(state, { type: 'forget', conversationId: 7 })), ['8']);
    assert.deepEqual(Object.keys(timelinesReducer(state, { type: 'keepOnly', conversationId: 7 })), ['7']);
    assert.deepEqual(timelinesReducer(state, { type: 'keepOnly', conversationId: null }), {});
  });

  it('builds a timeline from a latest page and what is known', () => {
    assert.deepEqual(seqs(withLatestPage([], range(1, 3))), [1, 2, 3]);
    assert.deepEqual(seqs(withLatestPage(range(1, 3), [])), [1, 2, 3]);
  });
});
