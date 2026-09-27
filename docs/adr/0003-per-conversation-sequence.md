# ADR 0003: Per-conversation message sequence with a row-lock counter

- **Status:** Accepted (2026-09-27). Implemented in Phase 1 (migration `0002_v2_schema`, the send transaction in `server/socket/socketHandler.js`). The rest of the D5 model is decided in Phase 5.
- **Decision record:** D5 in `docs/v2-design.md` §4, §5 and §10; `docs/phase-1-implementation-plan.md` §2, decision 4.

## Context

A chat client needs a message order that is the same for everyone, and later it needs to detect missed messages after a reconnect. Ordering by a global `id` or by `created_at` does not give that: both are assigned when the insert runs, but transactions commit in a different order, so a client that has "everything up to id 41" can still miss 40 if its transaction commits later. A catch-up query like `id > 41` would skip it forever.

## Decision

- Each conversation keeps a counter, `conversations.last_seq`. Each message stores its position, `messages.seq`, unique per conversation (`UNIQUE (conversation_id, seq)`).
- A send runs one transaction:
  1. `UPDATE conversations SET last_seq = last_seq + 1, last_message_at = now() WHERE id = … RETURNING last_seq`. The update takes the conversation's row lock until the transaction ends, so a second send to the same conversation waits: seqs are handed out in commit order.
  2. `INSERT … SELECT … WHERE EXISTS (membership)` with that seq. If the sender is not a member, nothing is inserted and the transaction rolls back.
  3. The sender's `conversation_members.last_read_seq` moves forward to the new seq (`GREATEST`).
  4. Only after `COMMIT` is the message broadcast.
- A rollback also rolls back the counter increment, so a failed send never leaves a gap.
- `conversation_members.last_read_seq` makes unread counts `last_seq - last_read_seq`, with no `COUNT(*)`. A new member starts at the conversation's current `last_seq`.
- `rev`/`last_rev` (the change feed for edits and deletes) are **not** added yet. They are the other half of the full D5 model, decided at the Phase 5 decision point, and are added before editing and deletion (Phase 7) if that model is chosen.

## Alternatives considered

- **Order by `id` or `created_at`.** Not stable under concurrent commits (see Context). The D5 "minimal" level orders by `id` and works around this by reloading the latest page to catch up (never `id > X`); it stays available if counters prove impractical.
- **`SELECT max(seq) + 1`.** Races: concurrent transactions can read the same maximum. With it in place of the row lock, the 20-send concurrency test failed: not every send was stored.
- **A Postgres sequence per conversation.** Sequences are not transactional: a rolled-back send still consumes a value, which leaves gaps, and gaps would look like missed messages to the client.
- **An advisory lock per conversation.** Works, but adds a second mechanism next to a row that already needs updating (`last_seq`, `last_message_at`).

## Consequences

- Within one conversation, sends are serialized on the row lock: roughly hundreds per second per conversation, far above what Relay needs. Different conversations do not contend.
- Guarantees, proven by `server/test/ordering.test.ts`: 20 concurrent sends from two users get exactly seq 1–20; a send that fails after taking a seq leaves `last_seq` unchanged and the next message gets the next seq; history is ordered by `seq`, not `created_at`; each sender's `last_read_seq` is their latest message. Breaking each part (no rollback, `max(seq)+1`, no read position) fails its test.
- The message payloads carry `seq` from Phase 1, although the client does not use it until Phase 4, so no later phase has to retrofit it.
- The membership check runs in the insert statement, after the conversation row is locked. Under READ COMMITTED that statement sees every membership change committed before it started. So when removals arrive (Phase 3), the removal must take the same row lock: then a removal and a send are strictly ordered, and no message is accepted from a member whose removal has committed.
