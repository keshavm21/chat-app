# Relay — V2 Design

**Status:** Proposal. The architectural decisions in [§10](#10-decisions-to-approve-before-implementation) (D1–D17) are **pending approval**. Recommendations marked **(D#)** depend on those decisions and are not final until approved.

**Based on:** `docs/current-state-audit.md` (repository at commit `2e72c1d`).

**How to read this document**

- Statements about the existing system come from the current-state audit and cite it as "audit §N".
- Anything the audit could not verify is labeled as an assumption or as something to verify.
- No application code is changed by this document.

**Contents**

- [Key recommendation](#key-recommendation)
- [A. Fundamental architectural changes](#a-fundamental-architectural-changes)
- [B. Feature evaluation](#b-feature-evaluation)
- [1. V2 product definition](#1-v2-product-definition)
- [2. Feature scope](#2-feature-scope)
- [3. Target architecture](#3-target-architecture)
- [4. Target database model](#4-target-database-model)
- [5. Real-time architecture](#5-real-time-architecture)
- [6. Security model](#6-security-model)
- [7. Testing strategy and engineering quality](#7-testing-strategy-and-engineering-quality)
- [8. Deployment strategy](#8-deployment-strategy)
- [9. Implementation roadmap](#9-implementation-roadmap)
- [10. Decisions to approve before implementation](#10-decisions-to-approve-before-implementation)
- [Next steps](#next-steps)

---

## Key recommendation

Relay V2 should be **a reliable, access-controlled team chat for a single community**. It has public channels, private channels and direct messages. It has per-channel roles, unread tracking that stays in sync across tabs, typing indicators, presence, and revocable sessions.

What sets it apart is **correctness and security depth, not feature count**. Messages are never lost, duplicated or shown out of order, even across reconnects, multiple tabs and deploys. Every read, write and real-time delivery is authorized by conversation membership.

Three ideas carry the design:

1. **The conversation is the unit of everything:** data, authorization, socket delivery and client state.
2. **PostgreSQL owns ordering.** Each conversation has counters. Messages get a gapless per-conversation `seq`, and every change gets a `rev`. Clients detect gaps and repair them over REST. The socket is a fast path, not the source of truth.
3. **Writes go through REST and sockets only push (D2).** This gives one validation, authorization and rate-limiting path.

V2 needs **no new infrastructure**: no Redis, no queue, no object storage, no search engine. PostgreSQL remains the only stateful component. The only possible new external item is a custom domain (D4).

This is an evolution of the existing app, not a rewrite:

- **Kept:** the stack (Express 5, Socket.io 4, pg, React 19, Vite, Tailwind), hosting (Render, Vercel, Neon), existing bcrypt password hashes, parameterized SQL, the save-then-broadcast pattern, handshake authentication, and the landing, login and signup pages with their visual design.
- **Rebuilt in place:** the schema (through migrations), the socket handler, the message routes and `Chat.jsx`. The audit shows these layers all assume a single room, so they have to change.

---

## A. Fundamental architectural changes

| # | Change | Today (verified, audit ref) | Why it is required |
|---|---|---|---|
| 1 | **Conversation becomes the core entity** | One global message stream across schema, API, events and client state (§1, §2) | Every other change is keyed by `conversation_id` |
| 2 | **Membership-based authorization in one policy module, used by REST and sockets** | Only rule is "is authenticated"; token checks duplicated (§2, §6) | Private conversations are safe only if every read, write and delivery goes through one checked path |
| 3 | **Service and repository layers** | SQL written directly in route and socket handlers (§2) | Authorization, validation and business rules need one home that both transports call and tests can reach |
| 4 | **Targeted delivery via rooms** | `io.emit` to every socket (§2) | Messages must reach members only; membership changes must add and remove live sockets |
| 5 | **A database-owned ordering and sync protocol** | Load race, no dedup, no catch-up, no send acknowledgement (§4.3–4.5) | With many conversations and long-lived tabs, "whatever arrived on the socket" is not a state model |
| 6 | **Ephemeral state keyed by user and conversation** | Presence and typing tracked per socket, per process (§5, §8.1) | Multi-tab correctness and per-conversation typing |
| 7 | **Revocable identity; username removed from tokens and messages** | 7-day irrevocable JWT in `localStorage`; username in the JWT and copied into every message (§7.3, §8.3, §8.6) | Profiles, "log out everywhere", and cutting off live sockets |
| 8 | **Explicit, typed client–server contract** | Untyped, unversioned events; client and server deploy separately (§8.2, §11) | Many new events, and old tabs will talk to new servers |
| 9 | **Routed, conversation-scoped client** | 457-line `Chat.jsx` owns everything in local `useState` (§2) | Sidebar, per-conversation caches, unread state, reconciliation |
| 10 | **Engineering substrate** | No migrations, tests, CI, server lint, env validation or error handler (§5, §6) | Changing a live schema is unsafe without migrations; sync logic cannot be verified without integration tests |

---

## B. Feature evaluation

| Feature | User value | Engineering value | Complexity | Architectural impact | Interview value | Include? |
|---|---|---|---|---|---|---|
| Profiles (display name, immutable username) | Recognizable identity | Removes username denormalization; case-insensitive uniqueness | Low | `users` columns, PATCH endpoint | Low–Med: denormalization tradeoffs | **Core** (minimal) |
| Profile pictures | Visual recognition | Uploads, object storage, validation | Med | New cloud service, upload pipeline | Med | **Optional** (defer; use initials avatars, D12) |
| Public channels | Open topic spaces | Directory, join/leave, membership | Med | Conversations and members tables, rooms | Med | **Core** |
| Private channels | Restricted spaces | Authorization that hides existence (404 vs 403), live room removal | Med | Visibility, roles, invite flow | **High** | **Core** |
| 1:1 DMs | Private conversation | Uniqueness under concurrency (get-or-create race) | Med | `direct_conversations` side table | **High** | **Core** |
| Group conversations (ad hoc) | Small-group chat | Mostly duplicates private channels | Med | Membership rules for unnamed groups | Low | **Exclude** (private channels cover this) |
| Roles and permissions | Channel control | Authorization model, permission matrix, tests | Med | `role` on membership, policy module | **High** | **Core** (per-channel owner/admin/member only) |
| Message editing | Fix mistakes | Change propagation, catch-up of old messages | Low extra, once deletion exists | `edited_at`, reuses `rev` | Med | **Strong addition** |
| Message deletion | Privacy, moderation | Soft delete vs erasure, propagation to offline clients | Med | `deleted_at`, `rev` change feed | **High** (drives sync design) | **Core** |
| Reactions | Lightweight feedback | Another table and event, little that is new | Low–Med | Reactions table, events | Low | **Optional** |
| Replies / threads | Structured discussion | Threads need separate unread semantics and UI | Threads High | `parent_id`, thread views | Med | **Exclude threads**; inline quote-reply is Optional |
| Typing indicators | Liveness | Stateless relay with TTL, throttling | Low | Socket only | Med | **Core** (redesigned) |
| Presence | Who is around | Multi-tab aggregation, grace periods, single-instance limits | Low–Med | In-memory map, socket lifecycle | **High** (scaling discussion) | **Core** (online/offline only) |
| Read position (own) | Resume where you left off | Monotonic updates, cross-tab sync | Low | `last_read_seq` on membership | Med | **Core** (it is the basis for unread counts) |
| Per-message read receipts ("seen by") | Social signal | Fan-out, privacy | Med–High for groups | Receipts or cursor exposure | Med | **Optional** (DM-only "Seen" at most) |
| Unread counts | Essential once there are many conversations | O(1) counts from counters, cross-tab consistency | Med | Counters on conversation and membership | **High** | **Core** |
| Notifications | Awareness when away | Push/email needs workers, providers, service workers | High | New infra | Med | **Exclude** push/email; in-app badges come with unread counts |
| Message search | Find old content | Postgres full-text search, GIN index, search restricted by membership | Med | Generated `tsvector` column plus index | **High** for no new infra | **Strong addition** (late phase) |
| Attachments | Share files | Presigned uploads, content validation, orphan cleanup | High | Object storage (new service), metadata table | High | **Optional** (defer, D12) |
| Channel moderation (admin removes member or deletes message) | Healthy channels | Comes out of roles and deletion | Low extra | Policy rules | Med | **Core** (via roles) |
| Global moderation (bans, site admins) | Instance safety | Second authorization tier, admin UI | Med–High | Global roles | Low–Med | **Exclude** |
| Reporting | Abuse handling | Needs someone to review reports | Med | Reports table, admin UI | Low | **Exclude** |
| Pagination | Required at scale | Keyset pagination | Low | Index plus query params | Med | **Core** |
| Reconnect / catch-up | No silent gaps | Gap detection, idempotent application | Med | Sync protocol | **Very high** | **Core** |
| Rate limiting | Abuse resistance | Per-IP vs per-user limits, proxy trust | Low–Med | Middleware, socket throttles | Med–High | **Core** |
| Session management ("log out other devices") | Account safety | Nearly free with server-side sessions | Low | Sessions table | Med | **Strong addition** |

---

## 1. V2 product definition

**What Relay is:** real-time team chat for one community, with public channels, private channels and DMs, built around reliable delivery and strict access control.

**Who uses it:** a small team, club or study group, from tens to low hundreds of users, on one shared instance. There are no workspaces or tenants. A secondary audience is the people evaluating the portfolio, which affects demo access (D15).

**Assumption to confirm:** scale is at most a few hundred concurrent sockets and a few messages per second, on a single server instance (D16).

**What users can do:**

1. Sign up, log in, edit their display name, and see or revoke their active sessions.
2. Browse and join public channels, and create public or private channels.
3. As channel admins, add members to private channels, remove members, delete any message, rename the channel and set its topic.
4. Start a DM with any user.
5. Send messages that survive flaky networks: failed sends keep their text and can be retried without duplicates.
6. Scroll back through history.
7. Delete their own messages, and edit them if editing is approved.
8. See unread counts that stay consistent across tabs and devices.
9. See typing indicators and who is online.
10. Search their conversations, if search is approved.

**What makes it more than basic chat:**

1. **Delivery guarantees:** per-conversation ordering, idempotent sends, and gap detection with repair. Correctness holds through reconnects, multiple tabs, server restarts and the initial page load.
2. **Uniform authorization:** one policy module governs REST reads, REST writes and socket delivery. Removed members stop receiving messages immediately.
3. **Revocable sessions:** logging out cuts off live sockets as well as HTTP requests.
4. **Deliberate data design:** constraints, keyset pagination, counter-based unread counts, and concurrency-safe DM creation.
5. **A verified system:** migrations, integration tests against real Postgres and real sockets, E2E tests of reconnect behavior, and CI gating deploys.

**Explicitly out of scope:** workspaces or multi-tenancy, threads, voice and video, push or email notifications, email verification and password reset (no email provider), OAuth, global moderation and reporting, attachments and avatars (unless D12 changes), end-to-end encryption, bots and integrations, AI features, native mobile apps, account deletion, and running multiple server instances (the scaling path is designed and documented but not implemented).

---

## 2. Feature scope

- **Core:** accounts with minimal profiles, revocable sessions, public channels, private channels, DMs, per-channel roles and moderation, messaging with keyset pagination, idempotent sends with retry, reconnect catch-up, soft delete, unread counts with cross-tab read state, typing, presence, rate limiting, input validation.
- **Strong additions (recommended, cuttable):** message editing (low marginal cost once deletion and `rev` exist), session management UI, Postgres full-text search (D11).
- **Optional (post-V2):** reactions, quote-replies, DM "Seen" receipts, browser notifications while the tab is open, avatars and attachments.
- **Excluded:** everything in the out-of-scope list in §1.

---

## 3. Target architecture

```
Browser: React SPA (Vercel, app.<domain>)
   │  HTTPS REST, cookie session       ─────┐
   │  WSS Socket.io, same cookie       ─────┤
   ▼                                        ▼
Express 5 + Socket.io 4 (Render, api.<domain>, single instance)
   transport (http routes, socket handlers)
     → services (business rules + authorization policy)
       → repositories (hand-written SQL via pg)
   ▼
PostgreSQL (Neon), the only stateful component
```

| Component | Choice | Status | Justification |
|---|---|---|---|
| Frontend | React 19, Vite, Tailwind, React Router, TypeScript | Kept + TS | No reason to change the stack |
| Server state (client) | TanStack Query for conversations, members and profiles; a small message store for timelines | New (D9) | Timelines need custom reconciliation (pending, confirmed and failed states; merge by `rev`) |
| Backend | Express 5 + Socket.io 4 in one process | Kept, restructured | Layering replaces SQL-in-handlers |
| Shared contract | `packages/shared`: zod schemas, typed socket event maps, error codes, limits | New (D7) | One definition validates and types both sides |
| Database | PostgreSQL on Neon | Kept | Relational data with real integrity and concurrency needs |
| Auth | Server-side sessions, opaque token in an httpOnly cookie, stored in Postgres | Changed (D3) | Revocation, no token readable by JavaScript |
| Validation | zod at every boundary, plus database CHECK constraints | New dependency | Shared schemas; database constraints as defense in depth |
| Logging | pino (JSON, request IDs) | New dependency | Structured logs searchable on Render |
| Security middleware | helmet, express-rate-limit (in-memory store) | New dependencies | Standard, small, well understood |
| File storage | None | — | No uploads in scope (D12) |
| Background jobs | None. An in-process interval deletes expired sessions and re-checks sockets' sessions | — | One instance; a queue would have nothing to do |
| Caching | None | — | Session lookup is one indexed primary-key query per request; measure before caching |
| Redis | None | — | Needed only for multiple instances (shared adapter, presence, rate-limit store). Documented as the scaling path |

**Server module layout (conceptual):**

- `http/`: routes, middleware, error handler
- `socket/`: handshake, room management, event handlers
- `services/`: conversations, messages, membership, sessions
- `policy/`: authorization rules
- `repositories/`: SQL
- `config/`: validated environment variables
- `lib/`: logger, errors

Routes and socket handlers stay thin. Everything with a rule in it lives in services.

**Client structure:**

- **Routes:** `/`, `/login`, `/signup`, `/c/:conversationId`, `/browse`, `/settings`.
- **Components:** the chat view splits into sidebar, conversation header, message list (with memoized items) and composer. The composer owns its own state, which fixes the per-keystroke re-render (audit §5).
- **Real-time:** one socket manager module feeds events into the stores. The merge and gap-detection logic is written as pure functions so it can be unit tested.
- **Auth:** `AuthContext` is driven by `GET /api/auth/me`. No token is ever visible to JavaScript.
- **HTTP:** Axios stays, with a response interceptor that treats any 401 as logout.

**REST API:**

| Area | Endpoints |
|---|---|
| Auth | `POST /api/auth/signup`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`, `GET /api/auth/sessions`, `DELETE /api/auth/sessions/:id` |
| Users | `GET /api/users?q=` (username prefix, for DMs and invites; rate limited), `PATCH /api/users/me` |
| Conversations | `GET /api/conversations` (mine, with `lastSeq`, `lastRev`, `lastReadSeq`, `unreadCount`); `GET /api/channels?q=` (public directory); `POST /api/channels`; `POST /api/dms {userId}` (get-or-create, idempotent); `GET`, `PATCH`, `DELETE /api/conversations/:id`; `POST …/:id/join`; `POST …/:id/leave` |
| Members | `GET …/:id/members`, `POST …/:id/members`, `PATCH …/:id/members/:userId` (role), `DELETE …/:id/members/:userId` |
| Messages | `GET …/:id/messages?before=<seq>&limit=`, `GET …/:id/messages/changes?afterRev=`, `POST …/:id/messages {clientId, content}`, `PATCH /api/messages/:id`, `DELETE /api/messages/:id` |
| Read state | `PUT …/:id/read {seq}` |
| Search (if approved) | `GET /api/search?q=&conversationId=` |
| Health | `GET /health/live`, `GET /health/ready` |

**API conventions:**

- Errors use one envelope: `{ error: { code, message, details? } }`. The codes live in the shared package. This fixes audit §4.1 structurally.
- Status codes: 400 for validation failures, 401 for no session, 403 when a member lacks the role, 404 for anything a non-member cannot see, 409 for conflicts, 429 for rate limits.
- No `/v1` prefix, because there is only one client. Compatibility is handled through the shared types plus the protocol-version check (§5).

---

## 4. Target database model

All timestamps are `timestamptz`. IDs are `integer GENERATED ALWAYS AS IDENTITY` (D10). Note that `pg` returns `bigint` as a JavaScript string, so int4 avoids that trap at this scale.

| Table | Columns and constraints |
|---|---|
| `users` | `id` PK; `username` UNIQUE, CHECK `^[a-z0-9_]{3,32}$` (lowercase, immutable); `email` UNIQUE, CHECK `email = lower(email)`; `display_name` CHECK length 1–50; `password_hash`; `created_at`, `updated_at` |
| `sessions` | `token_hash bytea` PK (SHA-256 of the cookie token); `user_id` FK → users ON DELETE CASCADE; `created_at`; `last_seen_at`; `expires_at`; `user_agent` |
| `conversations` | `id` PK; `type` CHECK in (`channel`, `dm`); `visibility` CHECK in (`public`, `private`); `name` CHECK `^[a-z0-9-]{1,40}$`; `topic`; `created_by` FK → users ON DELETE SET NULL; `last_seq int NOT NULL DEFAULT 0`; `last_rev int NOT NULL DEFAULT 0`; `last_message_at`; `created_at`, `updated_at`. A table-level CHECK requires channels to have `name` and `visibility`, and DMs to have neither |
| `direct_conversations` | `conversation_id` PK/FK → conversations ON DELETE CASCADE; `user_a_id`, `user_b_id` FK → users; CHECK `user_a_id < user_b_id` (also blocks self-DMs); UNIQUE (`user_a_id`, `user_b_id`) |
| `conversation_members` | PK (`conversation_id`, `user_id`), both FKs ON DELETE CASCADE; `role` CHECK in (`owner`, `admin`, `member`); `last_read_seq int NOT NULL DEFAULT 0`; `joined_at` |
| `messages` | `id` PK; `conversation_id` FK ON DELETE CASCADE; `seq`; `rev`; `author_id` FK → users ON DELETE RESTRICT; `client_id uuid`; `content`; `created_at`; `edited_at`; `deleted_at`. UNIQUE (`conversation_id`, `seq`); UNIQUE (`author_id`, `client_id`); CHECK `deleted_at IS NOT NULL OR char_length(content) BETWEEN 1 AND 4000` |

**Indexes:**

| Index | Serves |
|---|---|
| `messages` UNIQUE (`conversation_id`, `seq`) | Keyset history pagination and gap fetches |
| `messages` (`conversation_id`, `rev`) | Change feed for catch-up |
| `messages` UNIQUE (`author_id`, `client_id`) | Idempotent sends (also covers the `author_id` foreign key) |
| `conversation_members` (`user_id`, `conversation_id`) | "My conversations" and joining rooms on connect |
| `conversations` partial UNIQUE (`name`) WHERE `type = 'channel'` | Unique channel names |
| `sessions` (`user_id`), (`expires_at`) | Session list; expiry cleanup |
| `messages` GIN (generated `tsvector`), only if search is approved | Full-text search |

**Important decisions:**

1. **Per-conversation counters instead of global ID ordering (D5).**
   - A global serial ID is allocated at insert, but transactions can commit out of ID order. A catch-up query like `id > X` can therefore permanently skip a message.
   - The send transaction instead increments `conversations.last_seq` and `last_rev` with an `UPDATE … RETURNING`. That takes a row lock, so within a conversation the sequence values are assigned in commit order with no gaps. A rolled-back transaction rolls back its increment too.
   - This gives three things: safe catch-up, gap detection on the client, and O(1) unread counts (`last_seq - last_read_seq`).
   - The cost is that sends within one conversation are serialized. That is fine at chat volumes and makes a good discussion point.
2. **Two counters, `seq` and `rev`.**
   - `seq` is a message's permanent position, used for ordering, pagination and unread counts.
   - `rev` increments on every create, edit or delete. It lets clients fetch "everything that changed since X". That matters because once deletion exists, a deleted old message must disappear from clients that were offline when it happened.
3. **One `conversations` table with a type discriminator,** plus a DM side table. Messages, members, rooms and read state all work the same way for every conversation type. DM-only rules (exactly two members, uniqueness) live in `direct_conversations`, where the unique pair constraint resolves concurrent "start DM" requests with `INSERT … ON CONFLICT`.
4. **Soft delete that erases content.** The row stays, which keeps `seq` gapless and keeps the history intact. The content is cleared, which honors the user's intent and is what "delete" should mean for privacy.
5. **Denormalization.**
   - The username copy is removed from `messages`. Author details come from a join on the primary key.
   - `last_seq` and `last_message_at` are the one intentional denormalization. They power sidebar sorting and unread counts without aggregate queries, and are updated in the same transaction as the insert.
6. **Case-insensitivity by normalization plus CHECK constraints,** rather than the `citext` extension. This is simpler and explicit. The constraint guarantees nothing unnormalized gets in.
7. **Constraints mirror the zod limits,** so the database stays consistent even if application code has a bug.

**Migrating existing data** (if D6 is "preserve"):

1. Capture the real production schema with `pg_dump --schema-only`. The audit says it is unknown.
2. Record it as a baseline migration.
3. Create the new tables.
4. Create a public `#general` channel and add every existing user to it.
5. Backfill `conversation_id` on existing messages, and backfill `seq`/`rev` with `row_number()` ordered by `(created_at, id)`.
6. Convert `created_at` to `timestamptz` using the database session time zone. That time zone must be checked first; the audit lists it as unknown.
7. Lowercase emails and usernames, after first checking for rows that would collide.
8. Drop `messages.username` in a later "contract" migration, once no deployed code reads it.

---

## 5. Real-time architecture

**Rooms:**

| Room | Members | Used for |
|---|---|---|
| `conv:{id}` | Sockets of all members | Message events, conversation and member events, typing, presence |
| `user:{id}` | All of one user's sockets (every tab and device) | Read-state sync, added to or removed from a conversation |
| `session:{hash}` | Sockets of one session | Immediate disconnect on logout or revocation |

Membership changes call `io.in('user:X').socketsJoin/socketsLeave('conv:Y')` (Socket.io 4 APIs). A removed member stops receiving messages immediately, in every tab. Inside socket handlers, `socket.rooms` doubles as a membership cache that is always current, for example to authorize typing events.

**Events** (typed through Socket.io's event-map generics in the shared package):

| Direction | Event | Target | Payload |
|---|---|---|---|
| S→C | `message:created`, `message:updated` | conv room | The full message state, including `seq` and `rev`. Edits and deletes use `updated`; a delete arrives as the full message with `deletedAt` set and content cleared |
| S→C | `conversation:joined`, `conversation:left` | user room | Conversation summary / `{conversationId, reason}` |
| S→C | `conversation:updated`, `member:joined`, `member:left` | conv room | Changed state |
| S→C | `read:updated` | user room | `{conversationId, lastReadSeq}` |
| S→C | `typing` | conv room, except the sender | `{conversationId, userId}` |
| S→C | `presence:updated` | the user's conv rooms | `{userId, online}` |
| S→C | `session:revoked` | session room | Sent just before the server disconnects those sockets |
| C→S | `typing` | — | `{conversationId}`; throttled; no acknowledgement |

With D2 = REST writes, `typing` is the only client-to-server event. If socket writes are chosen instead, the client would also emit `message:send` with an acknowledgement callback returning `{ok, message}` or `{ok: false, error}`, using the same `clientId` idempotency.

Events carry full state rather than deltas. This makes applying them idempotent: the client keeps a message only if the incoming `rev` is higher than the one it has. Duplicates and out-of-order arrivals then converge to the same state without special handling.

**Connection lifecycle:**

1. **Connect.** After `/me` succeeds, the client connects. The cookie is sent automatically, and the handshake includes `auth: { protocolVersion }`.
2. **Handshake checks.** Server middleware checks, in order:
   - the Origin against an allowlist (protection against cross-site WebSocket hijacking; CORS does not protect WebSockets);
   - the session;
   - the protocol version.

   It rejects with `UNAUTHENTICATED` or `CLIENT_OUTDATED`. On `CLIENT_OUTDATED` the client prompts a reload, which handles audit §8.2.
3. **Join rooms.** On connection, one query fetches the user's memberships. The socket joins its user, session and conversation rooms, and presence is registered.
4. **Sync.** On every connect, including reconnects, the client runs the sync procedure below.
5. **Disconnect.** Socket.io reconnects with backoff automatically. Presence goes offline only after a grace period.
6. **Shutdown.** On SIGTERM the server calls `io.close()`. Clients reconnect to the new instance and sync.

**Message delivery (REST write path):**

1. **Local pending state.** The composer generates a `clientId` (UUID) and shows the message as *pending*.
2. **Request.** The client sends `POST /messages {clientId, content}`.
3. **Server transaction.** The server validates, applies the rate limit and authorizes membership. Then, in one transaction, it:
   - increments the conversation counters (which takes the row lock);
   - inserts the message, guarded by a membership `EXISTS` check so that a concurrent removal cannot slip a message through;
   - advances the sender's `last_read_seq`.

   After **commit** it emits `message:created` and returns 201. Events are never emitted inside the transaction.
4. **Reconciliation.** The client matches its pending message by `clientId`, using whichever arrives first: the HTTP response or the socket echo.
5. **Failure handling.** On a network error or 5xx, the message is marked *failed* and its text is kept. Retry resends the same `clientId`. If the first attempt actually committed, the unique constraint makes the server return the existing message with 200, so there is no duplicate. This fixes audit §4.5.
6. **Crash between commit and emit.** The message is stored but not broadcast. Other clients see a `rev` gap on the next event or on reconnect, and repair it.

This gives **at-least-once delivery through pull-based repair.** Socket delivery is best-effort; correctness comes from the database.

**Sync and catch-up procedure:**

1. `GET /api/conversations` reconciles the sidebar: added or removed conversations, `lastSeq`, `lastRev` and unread counts.
2. For each conversation with loaded messages where the server's `lastRev` is ahead of the local one, the client fetches `GET …/changes?afterRev=` and applies the results as upserts.
3. If the change set is very large, the client discards that conversation's cache and reloads the latest page. This bounds the work after long disconnects.
4. Live events that arrive during sync are applied normally. Because application is idempotent, the order does not matter.
5. At any time, an event whose `rev` is greater than local `lastRev + 1` triggers the same repair.

This removes the page-load race (audit §4.3) instead of trying to time around it: the socket connects first, and the REST page and live events merge correctly in any order.

Socket.io also has built-in *connection state recovery*. The recommendation is not to use it. It keeps missed packets in memory only, does not survive restarts or deploys, and would add a second recovery path alongside the one that is needed anyway.

**Presence:**

- An in-memory map of `userId → Set<socketId>`. A user is online from their first socket and offline once they have zero sockets for about 15 seconds, so page refreshes do not flicker.
- Changes are broadcast with `io.to([...their conversation rooms])`. Socket.io delivers once per socket even when that socket is in several of the rooms.
- The initial snapshot comes with the members and DM list responses.
- Online/offline only. No "last seen", which avoids a persistence and privacy question.
- This is **explicitly single-instance.** It is the first thing that breaks when a second instance runs, so it belongs in the documentation and in interview answers.

**Typing:**

- The client emits `typing` at most every 3 seconds while composing.
- The server checks that the socket is in `conv:{id}`, drops events beyond the throttle, and relays the event.
- Receivers show the indicator for about 5 seconds unless it is refreshed, and ignore their own `userId`.
- The server holds **no typing state.** That fixes the audit §5 bug where closing one tab cleared the indicator for another, and it works unchanged with multiple instances.

**Read state and receipts:**

- When a conversation is visible, focused and scrolled to the bottom, the client sends `PUT /read {seq}`, debounced.
- The server applies `last_read_seq = GREATEST(last_read_seq, $seq)`, so updates are monotonic and concurrent tabs cannot move the position backwards. It then emits `read:updated` to the user room.
- A "Seen" indicator for DMs (optional) would also emit to the conversation room.

**Multiple tabs and devices:**

| Concern | Mechanism |
|---|---|
| New messages | Conv room reaches every tab |
| Own send appears in other tabs | Socket echo; tabs without a pending entry insert it normally |
| Unread badges | `read:updated` via the user room |
| Removed from a channel | `socketsLeave` plus `conversation:left` to all tabs |
| Logout in one tab | Session sockets disconnected; other sessions unaffected |
| Presence | Counted per user, not per socket |

---

## 6. Security model

**Authentication options (D3):**

| Option | Token theft via XSS | Revocation | CSRF exposure | Complexity | Split-domain deploy |
|---|---|---|---|---|---|
| Current: JWT in `localStorage`, 7 days | Readable | None | None | Low | Works |
| JWT in an httpOnly cookie | Not readable | None without a denylist, which reintroduces state | Yes | Low | Needs a same-site setup |
| Short access JWT plus rotating refresh cookie | Refresh token not readable | On refresh only (minutes of delay) | Refresh endpoint | **High** (rotation, reuse detection, two code paths) | Needs a same-site setup |
| **Server-side session** (opaque token in httpOnly cookie, stored in Postgres) | Not readable | Immediate | Yes (mitigated below) | Low–Med | Needs a same-site setup |

**Recommendation: server-side sessions.**

- JWT's real advantage is verification without a database lookup, which matters across many services. Relay has one service that already queries the database on every request.
- A revocation requirement puts state back into a JWT design anyway, at which point sessions are simpler.
- What httpOnly buys, precisely: XSS can still *act as the user* while the page is open, but it can no longer *steal a token* and use it elsewhere. React's escaping and a CSP remain the actual XSS defenses.

**Session details (proposed defaults):**

- The token is 32 random bytes. Only its SHA-256 hash is stored, so a database leak does not yield usable sessions.
- Cookie: `__Host-relay_session`, `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`.
- Expiry: 7-day idle timeout (sliding, with `last_seen_at` updates throttled), 30-day absolute limit.
- A new session is created on every login.
- Logout deletes the session row and disconnects that session's sockets.
- An in-process sweep every few minutes checks all connected sockets' sessions in one query and disconnects any that are no longer valid. This fixes audit §7.8.

**Cross-site cookies (D4):**

- `*.vercel.app` and `*.onrender.com` are different sites, so a session cookie would be third-party. Safari blocks those by default.
- A custom domain with `app.` and `api.` subdomains makes the two same-site, so `SameSite=Lax` cookies work.
- The alternative is serving the SPA from Express so everything is one origin.

**CSRF:**

- `SameSite=Lax` blocks cross-site POSTs from carrying the cookie.
- The server also checks the `Origin` header on every state-changing request.
- Requiring `Content-Type: application/json` forces a preflight that CORS then denies.

These three layers are cheap and easy to explain.

**Authorization:**

- A single `policy` module with rules like `canPost`, `canDeleteMessage` and `canManageMembers`, called only from services.
- Private conversations and non-members get **404, not 403,** so their existence is not leaked.
- A test suite covers the full permission matrix.

| Action (channels) | Non-member (public) | Member | Admin | Owner |
|---|---|---|---|---|
| Read, post, react | Join first | ✓ | ✓ | ✓ |
| Edit or delete own messages | — | ✓ | ✓ | ✓ |
| Delete others' messages | — | — | ✓ | ✓ |
| Add members (private channel) | — | — | ✓ | ✓ |
| Remove members | — | — | ✓ (not owner) | ✓ |
| Change roles, delete channel | — | — | — | ✓ |

DMs have exactly two members and no roles. Members cannot leave or add people. Owners must transfer ownership before leaving.

**Rate limits** (proposed; in-memory store, acceptable on one instance):

| Surface | Key | Limit (starting point) |
|---|---|---|
| Login | IP + email | ~10 per 15 min |
| Signup | IP | ~5 per hour |
| Message send | user | ~20 per 10 s, returns 429 with `Retry-After` |
| DM and channel creation, user search | user | Modest per-minute caps |
| Socket `typing` | user + conversation | 1 per 2 s, excess dropped silently |

Express must set `trust proxy` to Render's actual proxy depth. Otherwise the client can spoof `X-Forwarded-For` and bypass IP limits, or every user shares the proxy's IP. The correct hop count needs to be verified.

**Other controls:**

1. **Validation:**
   - zod on every body, query, parameter and socket payload.
   - Message length 1–4000 characters after trimming.
   - `express.json({ limit: '16kb' })`.
   - Socket.io `maxHttpBufferSize` around 8 KB. This is safe because clients only send typing events over the socket, which is another benefit of REST writes.
2. **Passwords:**
   - Enforced server-side: at least 8 characters and at most 72 bytes (bcrypt's limit), rejected rather than silently truncated.
   - Existing bcrypt hashes keep working.
   - Login compares against a dummy hash when the email is unknown, so response timing does not reveal registered emails (fixes audit §7.4).
3. **Enumeration:**
   - Usernames are public by design.
   - Signup cannot fully hide whether an email is taken without email verification, which is out of scope. This is an accepted residual risk, reduced by rate limiting.
4. **Headers:**
   - helmet on the API.
   - A CSP on the SPA via `vercel.json`: `default-src 'self'`, `connect-src` limited to the API origin over HTTPS and WSS, `frame-ancestors 'none'`.
   - Self-host the fonts to remove the Google Fonts dependency.
5. **XSS:**
   - Plain-text messages rendered by React; no `dangerouslySetInnerHTML`.
   - If links are auto-linked later: allow only `http:` and `https:`, and use `rel="noopener noreferrer"`.
   - Markdown is out of scope.
6. **Database and secrets:**
   - Turn TLS certificate verification back on for Neon. Verify that the default CA bundle accepts Neon's certificate.
   - Validate all required environment variables at startup and refuse to boot without them. `JWT_SECRET` is no longer needed once sessions replace JWTs, because session tokens are random rather than signed.

---

## 7. Testing strategy and engineering quality

| Level | Tool | What it covers |
|---|---|---|
| Unit | Vitest | Policy rules, zod schemas, client merge, gap-detection and pending-reconciliation functions |
| API integration | Vitest + supertest against real Postgres | Every endpoint; the **full authorization matrix**; error envelope; rate limits |
| Database behavior | Same | Concurrent sends to one conversation produce gapless `seq`; concurrent DM creation yields one conversation; idempotent retry; constraints reject bad data |
| Socket integration | Server on an ephemeral port + `socket.io-client` | Non-members receive nothing; removed members stop receiving immediately; revoked sessions are disconnected; bad Origin rejected; typing relay and throttle; outdated protocol rejected |
| Component | React Testing Library (selective) | Composer failure and retry states, unread badges |
| E2E | Playwright, about 6–8 flows | Two browser contexts exchanging messages; going offline and back online, then catching up; failed send and retry; removal from a private channel; logout in one tab |

**Test database:** one Postgres instance (Docker Compose locally, a service container in CI), migrated once, with tables truncated before each test. This is recommended over wrapping each test in a rolled-back transaction, because the concurrency tests need real, separate transactions.

Coverage goals are about behavior (every policy rule and every sync path), not a percentage.

**TypeScript (D7):**

- Phase 0 sets up npm workspaces (`client`, `server`, `packages/shared`), a tsconfig with `allowJs`, and typecheck in CI.
- New code is written in TypeScript. Existing files are converted when they are rewritten anyway. Converting the single-room socket handler first would be wasted work, since it gets replaced.
- Strict mode, with no JavaScript remaining, is a completion criterion of the final phase.
- Server: `tsx` in development, `tsc` builds for production.

**Migrations (D8):**

- SQL-first migrations under version control, applied through a runner that takes an advisory lock.
- Run them over Neon's **direct (unpooled) connection.** The pooler's transaction mode does not reliably support session-level advisory locks; verify this for the Neon setup in use.
- Rule: **expand, then contract.** Every migration must work with both the currently deployed server and the new one, because the two overlap during deploys and old tabs stay open.

**Reliability basics:**

- A `pool.on('error')` handler (fixes audit §4.2).
- A global Express error handler and a JSON 404 handler.
- A typed `AppError` carrying `code` and `status`.
- Graceful shutdown on SIGTERM: stop accepting connections, close Socket.io, drain the pool.
- `/health/live` (process is up) and `/health/ready` (database answers `SELECT 1`).
- pino with a request ID per request, plus socket lifecycle logs.
- An ESLint configuration for the server.
- ADRs in `docs/adr/`, one per approved decision in §10. They are cheap to write and directly useful for interviews.

---

## 8. Deployment strategy

**Topology:**

- Vercel serves the SPA at `app.<domain>`.
- Render runs the API and sockets as one web service at `api.<domain>`.
- Neon hosts Postgres.
- This requires a custom domain (D4). Staying on the default hostnames would force either cross-site cookies, which Safari blocks, or serving the SPA from Express.
- Vercel rewrites are believed not to proxy WebSockets, which would rule out that shortcut. Verify before relying on it either way.

**Environments:** local (Docker Compose Postgres), CI (ephemeral Postgres), production. No staging environment, to keep cost down; Neon branches could provide one later if needed.

**CI (GitHub Actions)**, on every pull request, as required checks:

1. Lint and typecheck.
2. Unit tests.
3. Integration and socket tests with a Postgres service container.
4. Build.
5. Playwright E2E.

**CD:**

1. Merging to `main` triggers the deploys.
2. Render deploys after CI passes. Render has a "wait for CI checks" auto-deploy setting; verify it is available on the plan in use.
3. Migrations run before the new server starts, either as Render's pre-deploy command (verify plan availability) or at startup under the advisory lock.
4. Vercel deploys the client automatically.
5. Vercel preview deployments need a policy decision: point them at production with CORS allowlisting, or disable them. Preview URLs are not under the custom domain, so cookie authentication will not work there.

**Hosting plan (D13):** on the free Render tier, the instance sleeps when idle. That drops every socket, and the first visitor waits through a cold start, which is a poor first impression for a recruiter. An always-on paid instance avoids this; check current pricing. Neon's free tier is likely sufficient.

**Deploy continuity:**

- Clients reconnect and sync after every deploy, so a restart becomes a brief gap that is repaired automatically, not data loss.
- Whether Render overlaps the old and new instances during a deploy is unverified (audit §12). The expand/contract rule and the protocol-version check make either behavior safe.

---

## 9. Implementation roadmap

Each phase is deployable and leaves production working.

### Phase 0 — Foundation (on the existing single-room app)

- **Goal:** a safe base for change.
- **Changes:**
  - npm workspaces and TypeScript tooling; ESLint and Prettier on the server.
  - Vitest, Docker Compose Postgres, the migration runner, and a baseline migration taken from `pg_dump` of production.
  - CI.
  - Env validation, pool error handler, error envelope (with the matching client fix), global error handler, 404 handler, graceful shutdown, pino, health checks.
  - Remove dead files and fix the README.
  - Fix audit §4 items 1, 2, 6, 7, 8 and 9. Items 3–5 are fixed structurally in Phases 4–5 rather than patched twice.
- **Dependencies:** production schema captured.
- **Tests:** characterization tests of the current auth, messages and socket behavior.
- **Done when:** CI is green on every PR, current behavior is covered by tests, and the fixes are deployed.

### Phase 1 — Data model

- **Goal:** the V2 schema, reached with existing data intact.
- **Changes:** users normalization, `conversations`, `direct_conversations`, `conversation_members`, message columns (`conversation_id`, `seq`, `rev`, `client_id`, `deleted_at`), `timestamptz`, the `#general` backfill. The old single-room API keeps working, now reading and writing `#general`.
- **Dependencies:** Phase 0; D5, D6, D10.
- **Tests:** migration from an empty database and from a fixture of the old schema containing data; constraint tests; up/down on a copy.
- **Done when:** production is migrated with no behavior change for users.

### Phase 2 — Sessions and security baseline

- **Goal:** revocable authentication.
- **Changes:**
  - Sessions table, cookie auth, `/me`, logout, session list.
  - Origin and CSRF checks; socket handshake authenticated by cookie with an Origin check; session rooms and the periodic sweep.
  - Password rules and the timing fix; auth rate limits; helmet; `trust proxy`.
  - Client: remove `localStorage` token handling, add the 401 interceptor.
- **Dependencies:** Phase 0; **D3 and D4 resolved, and the domain live, before deploying.**
- **Tests:** auth API and CSRF tests; socket rejects missing or revoked sessions; logout disconnects the session's sockets.
- **Done when:** no token is readable by JavaScript and logout cuts off live sockets. Users are logged out once, accepted under D6.

### Phase 3 — Conversations and authorization (vertical slice)

- **Goal:** channels, DMs and memberships end to end.
- **Changes:**
  - Service, repository and policy layers.
  - Conversation, channel, DM and member endpoints.
  - Room joins on connect; live `socketsJoin`/`socketsLeave`; `conversation:*` and `member:*` events.
  - Client: routing, sidebar, channel browser, create and invite flows, TanStack Query.
- **Dependencies:** Phases 1 and 2.
- **Tests:** the full authorization matrix; the concurrent DM-creation race; a non-member receives nothing.
- **Done when:** users can create, join and leave conversations, and every permission rule is tested.

### Phase 4 — Messaging in conversations

- **Goal:** per-conversation messaging with ordering guarantees.
- **Changes:**
  - Send endpoint with the counter transaction and `clientId` idempotency.
  - Keyset pagination; `message:created` to rooms.
  - Client: `Chat.jsx` decomposed, message store, pending/confirmed/failed states, retry, load-older.
  - Remove the single-room API and events (the contract step), then drop `messages.username`.
- **Dependencies:** Phase 3; D2, D9.
- **Tests:** parallel sends produce gapless `seq`; retry does not duplicate; removed members stop receiving; pagination edges.
- **Done when:** audit issues §4.3 and §4.5 cannot be reproduced.

### Phase 5 — Sync and resilience

- **Goal:** correctness through disconnects.
- **Changes:** changes endpoint; sync-on-connect; gap detection and repair; protocol-version handshake; buffering of events during sync.
- **Dependencies:** Phase 4.
- **Tests:** unit tests of the merge logic with shuffled and duplicated events; socket tests with dropped events; Playwright offline/online test; a server restart during an active chat.
- **Done when:** audit issue §4.4 cannot be reproduced, and a restart mid-conversation loses nothing.

### Phase 6 — Awareness

- **Goal:** unread counts, read state, typing, presence.
- **Changes:** read endpoint with `GREATEST`; `read:updated`; unread computed from counters; stateless typing relay; presence map with a grace period.
- **Dependencies:** Phase 5.
- **Tests:** cross-tab read sync; monotonic read under concurrent updates; multi-tab presence; typing throttle.
- **Done when:** the audit §5 presence and typing issues are resolved.

### Phase 7 — Message lifecycle and moderation

- **Goal:** deletion (and editing, if approved) and admin moderation.
- **Changes:** DELETE (and PATCH) endpoints that bump `rev`; `message:updated`; admin deletes and member removal in the UI.
- **Dependencies:** Phase 5, because correctness relies on `rev` catch-up.
- **Tests:** a client that was offline during a delete sees it disappear after reconnecting; policy tests for deleting others' messages.
- **Done when:** edits and deletes propagate to every client, including ones that were offline.

### Phase 8 — Search (if approved)

- **Goal:** membership-restricted full-text search.
- **Changes:** generated `tsvector` column, GIN index, search endpoint joined against memberships, search UI.
- **Dependencies:** Phase 4.
- **Tests:** never returns results from conversations the user cannot access; `EXPLAIN` confirms the index is used.
- **Done when:** search works and cannot leak.

### Phase 9 — Hardening and launch

- **Goal:** production-ready and portfolio-ready.
- **Changes:**
  - Remaining rate limits and the CSP.
  - Strict TypeScript everywhere.
  - A security checklist review against §6.
  - An architecture document and ADRs.
  - Seeded demo data and demo access (D15).
  - Optionally, a small socket load script so any scaling claims are measured rather than guessed.
- **Dependencies:** all prior phases.
- **Tests:** the full E2E suite; the security checklist.
- **Done when:** a stranger can open the demo and use it, and every resume claim is backed by code or a test.

---

## 10. Decisions to approve before implementation

**None of these decisions has been approved yet.** The "Recommendation" column is the proposal, not a final choice.

| # | Decision | Options | Recommendation | Key tradeoff |
|---|---|---|---|---|
| D1 | Conversation types | Channels only; DMs only; public + private + DMs; plus group DMs | **Public + private channels + DMs** | More scope, but each type demonstrates a different authorization case |
| D2 | Write path | REST writes + socket push; socket writes with acknowledgements | **REST writes** | One extra HTTP round trip per send, in exchange for one validation, auth and rate-limit path |
| D3 | Auth model | Keep JWT and harden it; JWT in a cookie; access + refresh; server sessions | **Server sessions** | One database lookup per request, in exchange for immediate revocation and simplicity |
| D4 | Topology for cookies | Custom domain with subdomains; SPA served from Express; `SameSite=None` cross-site | **Custom domain** | Small yearly cost; `SameSite=None` breaks on Safari |
| D5 | Ordering and sync model | Order by global ID; per-conversation `seq`/`rev`; event-log table; Socket.io connection state recovery | **Per-conversation `seq`/`rev`** | Serialized writes per conversation, in exchange for gapless ordering and a simple catch-up |
| D6 | Existing data and sessions | Migrate into `#general` plus a one-time logout; reset | **Migrate + one-time logout** | Needs the production schema and data checked first |
| D7 | TypeScript and workspace | Stay on JS + JSDoc; TypeScript with a shared package | **TypeScript + workspaces + shared zod/event types** | Tooling setup cost, repaid by a typed contract |
| D8 | Data access and migrations | Raw `pg` + node-pg-migrate; Kysely; Drizzle/Prisma; plain SQL + custom runner | **Raw SQL repositories + node-pg-migrate** | Hand-typed result rows, in exchange for visible SQL skill and minimal churn |
| D9 | Client state | TanStack Query only; Query + small message store (Zustand); Context + reducer | **Query + Zustand message store** | Two tools, but timeline reconciliation is custom logic either way |
| D10 | IDs | int4 identity; bigint; UUIDv7 | **int4 identity** | Guessable, but harmless given membership checks; bigint arrives as strings in `pg`; native UUIDv7 needs PG 18 |
| D11 | Strong additions | Editing / search / session UI | **All three**, search last and cuttable | More time |
| D12 | Attachments and avatars | Defer; include with R2/S3 | **Defer; initials avatars** | Loses a strong upload-security topic, avoids a new cloud service |
| D13 | Render plan | Free with cold starts; always-on paid | **Always-on during job search** | Monthly cost, in exchange for a demo that works on first click |
| D14 | Reading public channels | Must join to read; read-only preview | **Must join** | One more click, in exchange for one uniform "read requires membership" rule |
| D15 | Access | Open signup; open signup + demo accounts; invite-only | **Open signup + rate limits + seeded demo login** | Spam risk, reduced by rate limits |
| D16 | Scale target | Single instance with a documented path; multi-instance now | **Single instance**; document the Postgres-adapter / Redis path | Presence stays in memory; honest, and justified by the scale target |
| D17 | Dependency budget | — | **Approve:** zod, pino, helmet, express-rate-limit, node-pg-migrate, TanStack Query, zustand, vitest, supertest, Playwright, Testing Library | Each one replaces hand-written infrastructure |

**Proposed defaults (apply unless changed):**

- 4000-character message limit.
- Sessions: 7-day idle timeout, 30-day absolute limit.
- Presence grace period of about 15 seconds.
- Immutable, lowercase usernames; slug-style channel names.
- DMs cannot be left; owners must transfer ownership before leaving.
- Soft delete with content erased.

### Extended analysis of the decisions that shape everything

#### D2: REST writes vs socket writes

- **Problem:** audit §11 shows REST and sockets already drift apart. Each extra write path duplicates validation, authorization and rate limiting.
- **Alternatives:**
  - Socket emits with acknowledgements: the current pattern, one connection, slightly lower latency.
  - REST for all writes, sockets for push and ephemeral signals only.
- **Tradeoffs:** REST adds per-request HTTP overhead, which is negligible with keep-alive at chat volumes. In return it gives standard status codes, idempotency, supertest-testable writes, middleware-based rate limiting, and a socket that almost only receives. That makes socket security much smaller: only typing is accepted from clients.
- **Interview defense:** "Persistence and authorization happen in one place. The socket is a notification channel, and correctness never depends on it. This is the same split several production chat systems use: writes through an HTTP API, delivery over a WebSocket."

#### D3: Server-side sessions vs JWT

- **Problem:** the current token cannot be revoked, is readable by any script on the page, and logging out does not disconnect sockets.
- **Alternatives:** see the comparison table in §6.
- **Why sessions fit Relay:** there is one service and it already queries the database, so JWT's stateless benefit is not used, while revocation is required.
- **Interview defense:** be able to answer "wouldn't JWT scale better?" Stateless verification helps when many services must verify tokens without a shared store. At Relay's scale, a primary-key lookup is microseconds. If it ever mattered, a cache in front of the sessions table would be the first step, not rotating refresh tokens.

#### D4: Deployment topology

- **Problem:** cookie authentication requires the client and API to be same-site, and today's hosts are cross-site.
- **Alternatives:**
  - A custom domain: keeps Vercel's CDN and deploy flow, costs a domain.
  - A single Express origin: no CORS at all and no domain needed, but loses Vercel and preview deployments.
  - `SameSite=None`: broken on Safari.
- **Interview value:** this decision shows an understanding of the difference between "same-site" and "same-origin", which is a strong signal of web-security knowledge.

#### D5: Per-conversation sequence and revision

- **Problem:** with global ID ordering, transactions can commit out of ID order, so "fetch everything after ID X" can skip messages. Separately, deletions have to reach clients that were offline.
- **Alternatives:**
  - Global IDs plus time windows: fragile.
  - An append-only event-log table: most general, but more storage and code.
  - Socket.io connection state recovery: in-memory only, does not survive deploys.
- **Choice:** counters on the conversation row, incremented under a row lock inside the send transaction.
- **Tradeoff:** writes within one conversation are serialized. That is an explicit, discussable limit: roughly hundreds of sends per second per conversation, far beyond Relay's needs.
- **Interview defense:** walk through the commit-order problem, show how the row lock makes sequence numbers gapless, and explain why gaplessness makes client-side gap detection possible. It is a strong answer to "how do you guarantee no messages are lost?"

#### D6: Preserve data

- **Problem:** the production schema, data volume and time zone are unknown (audit §12).
- **Recommendation:** preserve the data. Migrating a live system without losing data is itself a strong story.
- **Condition:** only if checking production turns up no blockers, such as emails that differ only by case or usernames that fail the new format. If the data is only test messages, resetting is legitimate and saves effort.

---

## Next steps

1. **Review and approve D1–D17.** Any of them may change; several later phases depend on these choices.
2. **Gather production facts before Phase 0 ends.** These block Phase 1:
   - `pg_dump --schema-only` of production;
   - `SHOW timezone` on the production database;
   - row counts;
   - checks for emails that differ only by case and for usernames that fail the new format;
   - which Render plan is in use, and whether production uses Neon's pooled or direct connection string.
3. **After approval, write ADRs for the approved decisions and a detailed Phase 0 plan,** with acceptance criteria and a file-by-file change list, before any code is written.
