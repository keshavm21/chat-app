# ADR 0006: Build only the visible features, and keep sending messages over the socket

- **Status:** Accepted (2026-09-30). Implemented in Phase 3 (`docs/phase-3-implementation-plan.md`, milestones M1–M3).
- **Decision record:** `docs/phase-3-implementation-plan.md` §3, decisions 1 and 2, and §9, question 1; this narrows D2 and the roadmap in `docs/v2-design.md` §9 and §10.

## Context

The V2 design (`docs/v2-design.md` §9) planned eight phases after the foundation: conversations, messaging with REST writes and `clientId` retries, catch-up sync with a change feed, presence and cross-tab read sync, editing and deletion, and a hardening phase. Phases 0–2 had built the base: the V2 schema, server-side sessions and the security baseline.

Relay runs on free tiers and is built by one person. What a visitor sees is a chat with channels and DMs that works live; most of the remaining phases add depth that only shows in failure cases (a retried send, an edit reaching an offline client) or in code review. Building all of them would take many times longer than building the visible part.

## Decision

1. **Visible features only.** Phase 3 builds public channels, minimal private channels (the owner adds members; members other than the owner can leave), DMs, messaging, typing and unread counts per conversation, a demo account with seeded channels, and one release of Phases 2 and 3 together. Not built (plan §2): roles beyond the owner and moderation, editing and deletion, REST sends with `clientId` retries, the change feed and gap detection, per-user presence, cross-tab read sync, strict TypeScript, the CSP, search and a session UI.
2. **Messages are still sent over the socket** (`new_message { conversationId, content }`), not with D2's `POST …/messages`. The send transaction from Phase 1 already takes any conversation and checks membership inside the insert, so per-conversation sending needed only the conversation id and a room per conversation.
3. **Sync at the design's "simplified" level** (`docs/v2-design.md` §5): seqs stay, but there is no `rev` or change feed. On every (re)connect the client refetches its conversation list and reloads the open conversation's latest page, merged by message id; other cached conversations are dropped and reload when opened.

## Alternatives considered

- **The full roadmap (Phases 4–8).** The most complete system, with the strongest delivery guarantees, but months more of work for features a visitor would not notice.
- **REST sends with `clientId` (D2).** Standard status codes, idempotent retries, and a socket that only receives. It means a second write path to build and test, and pending/failed states in the UI; the existing socket send already gives server-assigned, gapless order per conversation, with tests.
- **No seqs at all (the design's minimal level).** Simpler, but loses the gapless per-conversation order and the O(1) unread counts that Phase 1 already provides.

## Consequences

- A send lost between the client and the server (a dropped socket at the wrong moment) is not retried; the text stays in the composer while the socket is down, and the message is simply not sent if the drop happens mid-flight. Guarantee 2 of design §5 ("a retried send never creates a duplicate and never loses the user's text") holds only partly.
- Edits and deletes do not exist, so the missing change feed costs nothing yet; adding them later needs `rev` (design §4) or a reload strategy.
- Typing stays debounced on the server, per socket and conversation, rather than the design's stateless relay; another tab's indicator can still clear early when two tabs of one user type at once.
- Socket payloads are still checked by hand rather than with zod schemas, and messages have no rate limit; both remain on the list for later.
- The design's other phases stay documented as possible next steps (`docs/v2-design.md` §9), not as commitments.
