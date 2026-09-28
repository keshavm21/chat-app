# Relay — V2 Design

**Status:** Approved. **Phases 0 and 1 are complete (2026-09-27), and Phase 1 is in production** since the cutover the same day; **Phase 2 is complete (2026-09-28) on the `phase-2` branch** and awaits its release (see [§9](#9-implementation-roadmap)). Decisions D1–D17 were approved on 2026-09-27 (see [§10](#10-decision-record)). D6 was revised the same day: existing data is not preserved, and V2 starts with a fresh database. D5 and D9 are **flexible implementation choices**, not hard requirements. The last open item, how session cookies work in production while the custom domain is deferred, was decided in Phase 2: the SPA is served by Express ([§6](#6-security-model), ADR 0005).

**Based on:** `docs/current-state-audit.md` (repository at commit `2e72c1d`).

**How to read this document**

- Statements about the existing system come from the current-state audit and cite it as "audit §N".
- Anything the audit could not verify is labeled as an assumption or as something to verify.
- References such as **(D5)** point to the decision record in §10.
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
- [10. Decision record](#10-decision-record)
- [Next steps](#next-steps)

---

## Key recommendation

Relay V2 is **a reliable, access-controlled team chat for a single community**. It has public channels, private channels and 1:1 direct messages. It has per-channel roles, message editing and deletion, unread tracking that stays in sync across tabs, typing indicators, presence, and revocable sessions.

What sets it apart is **correctness and security depth, not feature count**. Messages are never lost, duplicated or shown out of order, even across reconnects, multiple tabs and deploys. Every read, write and real-time delivery is authorized by conversation membership.

Three ideas carry the design:

1. **The conversation is the unit of everything:** data, authorization, socket delivery and client state.
2. **PostgreSQL owns ordering (D5, flexible).** In the preferred model, each conversation has counters: messages get a gapless per-conversation `seq`, and every change gets a `rev`. Clients detect gaps and repair them over REST. If this proves disproportionately difficult, a simpler mechanism may be used, but the reliability guarantees in §5 are required either way. The socket is a fast path, not the source of truth.
3. **Writes go through REST and sockets only push (D2).** This gives one validation, authorization and rate-limiting path.

V2 needs **no new infrastructure**: no Redis, no queue, no object storage, no search engine (D16). PostgreSQL remains the only stateful component. New libraries are added only when a concrete need justifies them (D17).

This is an evolution of the existing app, not a rewrite:

- **Kept:** the stack (Express 5, Socket.io 4, pg, React 19, Vite, Tailwind), the current hosting providers (Render, Vercel, Neon; plan decisions deferred, D13), parameterized SQL, the save-then-broadcast pattern, handshake authentication, and the landing, login and signup pages with their visual design.
- **Designed fresh:** the database schema. Existing data is not preserved, so the schema follows §4 with no legacy constraints (D6).
- **Rebuilt in place:** the socket handler, the message routes and `Chat.jsx`. The audit shows these layers all assume a single room, so they have to change.

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
| 9 | **Routed, conversation-scoped client** | 457-line `Chat.jsx` owns everything in local `useState` (§2) | Sidebar, per-conversation state, unread state, reconciliation |
| 10 | **Engineering substrate** | No migrations, tests, CI, server lint, env validation or error handler (§5, §6) | Every environment needs the same schema, built reproducibly by migrations; sync logic cannot be verified without integration tests |

---

## B. Feature evaluation

**Legend:** **Core** = in V2. **Later** = planned after the V2 core (D11). **Deferred** = postponed by D12. **Optional** = not planned; candidates after V2. **Exclude** = out of scope.

| Feature | User value | Engineering value | Complexity | Architectural impact | Interview value | Include? |
|---|---|---|---|---|---|---|
| Profiles (display name, immutable username) | Recognizable identity | Removes username denormalization; case-insensitive uniqueness | Low | `users` columns, PATCH endpoint | Low–Med: denormalization tradeoffs | **Core** (minimal) |
| Profile pictures | Visual recognition | Uploads, object storage, validation | Med | New cloud service, upload pipeline | Med | **Deferred** (D12; initials shown instead) |
| Public channels | Open topic spaces | Directory, join/leave, membership | Med | Conversations and members tables, rooms | Med | **Core** |
| Private channels | Restricted spaces | Authorization that hides existence (404 vs 403), live room removal | Med | Visibility, roles, invite flow | **High** | **Core** |
| 1:1 DMs | Private conversation | Uniqueness under concurrency (get-or-create race) | Med | `direct_conversations` side table | **High** | **Core** |
| Group conversations (ad hoc) | Small-group chat | Mostly duplicates private channels | Med | Membership rules for unnamed groups | Low | **Exclude** (D1; private channels cover this) |
| Roles and permissions | Channel control | Authorization model, permission matrix, tests | Med | `role` on membership, policy module | **High** | **Core** (per-channel owner/admin/member only) |
| Message editing | Fix mistakes | Change propagation, catch-up of old messages | Low extra, once deletion exists | `edited_at`; reuses the sync mechanism | Med | **Core** (D11) |
| Message deletion | Privacy, moderation | Soft delete vs erasure, propagation to offline clients | Med | `deleted_at`; reuses the sync mechanism | **High** (drives sync design) | **Core** |
| Reactions | Lightweight feedback | Another table and event, little that is new | Low–Med | Reactions table, events | Low | **Optional** |
| Replies / threads | Structured discussion | Threads need separate unread semantics and UI | Threads High | `parent_id`, thread views | Med | **Exclude threads**; inline quote-reply is Optional |
| Typing indicators | Liveness | Stateless relay with TTL, throttling | Low | Socket only | Med | **Core** (redesigned) |
| Presence | Who is around | Multi-tab aggregation, grace periods, single-instance limits | Low–Med | In-memory map, socket lifecycle | **High** (scaling discussion) | **Core** (online/offline only) |
| Read position (own) | Resume where you left off | Monotonic updates, cross-tab sync | Low | `last_read_seq` on membership | Med | **Core** (it is the basis for unread counts) |
| Per-message read receipts ("seen by") | Social signal | Fan-out, privacy | Med–High for groups | Receipts or cursor exposure | Med | **Optional** (DM-only "Seen" at most) |
| Unread counts | Essential once there are many conversations | O(1) counts from counters, cross-tab consistency | Med | Counters on conversation and membership | **High** | **Core** |
| Notifications | Awareness when away | Push/email needs workers, providers, service workers | High | New infra | Med | **Exclude** push/email; in-app badges come with unread counts |
| Message search | Find old content | Postgres full-text search, GIN index, search restricted by membership | Med | Generated `tsvector` column plus index | **High** for no new infra | **Later** (D11) |
| Attachments | Share files | Presigned uploads, content validation, orphan cleanup | High | Object storage (new service), metadata table | High | **Deferred** (D12) |
| Channel moderation (admin removes member or deletes message) | Healthy channels | Comes out of roles and deletion | Low extra | Policy rules | Med | **Core** (via roles) |
| Global moderation (bans, site admins) | Instance safety | Second authorization tier, admin UI | Med–High | Global roles | Low–Med | **Exclude** |
| Reporting | Abuse handling | Needs someone to review reports | Med | Reports table, admin UI | Low | **Exclude** |
| Pagination | Required at scale | Keyset pagination | Low | Index plus query params | Med | **Core** |
| Reconnect / catch-up | No silent gaps | Gap detection, idempotent application | Med | Sync protocol | **Very high** | **Core** |
| Rate limiting | Abuse resistance | Per-IP vs per-user limits, proxy trust | Low–Med | Middleware, socket throttles | Med–High | **Core** (basic, D15) |
| Session revocation on logout | Account safety | Logout cuts off HTTP and live sockets | Low | Sessions table, session rooms | Med | **Core** (D3) |
| Session management UI ("log out other devices") | Account safety | Nearly free with server-side sessions | Low | Session list endpoints, settings page | Med | **Later** (D11) |

---

## 1. V2 product definition

**What Relay is:** real-time team chat for one community, with public channels, private channels and 1:1 DMs, built around reliable delivery and strict access control.

**Who uses it:** a small team, club or study group, from tens to low hundreds of users, on one shared instance. There are no workspaces or tenants. A secondary audience is the people evaluating the portfolio: signup is open with basic rate limiting, and seeded demo data is optional (D15).

**Assumption:** scale is at most a few hundred concurrent sockets and a few messages per second, on a single server instance (D16).

**What users can do:**

1. Sign up, log in, log out, and edit their display name.
2. Browse and join public channels, and create public or private channels. A public channel must be joined before it can be read (D14).
3. As channel admins, add members to private channels, remove members, delete any message, rename the channel and set its topic.
4. Start a 1:1 DM with any user.
5. Send messages that survive flaky networks: failed sends keep their text and can be retried without duplicates.
6. Scroll back through history.
7. Edit and delete their own messages (D11).
8. See unread counts that stay consistent across tabs and devices.
9. See typing indicators and who is online.

**What makes it more than basic chat:**

1. **Delivery guarantees:** per-conversation ordering, idempotent sends, deduplication, and catch-up after reconnects. Correctness holds through reconnects, multiple tabs, server restarts and the initial page load.
2. **Uniform authorization:** one policy module governs REST reads, REST writes and socket delivery. Removed members stop receiving messages immediately.
3. **Revocable sessions:** logging out cuts off live sockets as well as HTTP requests.
4. **Deliberate data design:** constraints, keyset pagination, counter-based unread counts, concurrency-safe DM creation, and a schema defined entirely by versioned migrations.
5. **A verified system:** migrations, integration tests against real Postgres and real sockets, E2E tests of reconnect behavior, and CI gating deploys.

**Explicitly out of scope:** workspaces or multi-tenancy, ad hoc group DMs, threads, voice and video, push or email notifications, email verification and password reset (no email provider), OAuth, global moderation and reporting, attachments and avatars (deferred, D12), end-to-end encryption, bots and integrations, AI features, native mobile apps, account deletion, and running multiple server instances (the scaling path is documented in §8, D16).

---

## 2. Feature scope

- **Core (V2):** accounts with minimal profiles, revocable sessions, public channels, private channels, 1:1 DMs, per-channel roles and moderation, messaging with keyset pagination, idempotent sends with retry, reconnect catch-up, message editing, soft delete, unread counts with cross-tab read state, typing, presence, basic rate limiting, and input validation.
- **Later (after the V2 core, D11):** Postgres full-text search; session management UI (list and revoke other sessions).
- **Optional (not planned):** reactions, quote-replies, DM "Seen" receipts, browser notifications while the tab is open, seeded demo data (D15).
- **Deferred (D12):** avatars and attachments. Initials are shown instead of avatars.
- **Excluded:** everything in the out-of-scope list in §1.

---

## 3. Target architecture

```
Browser: React SPA (currently Vercel)
   │  HTTPS REST, cookie session       ─────┐
   │  WSS Socket.io, same cookie       ─────┤
   ▼                                        ▼
Express 5 + Socket.io 4 (currently Render, single instance)
   transport (http routes, socket handlers)
     → services (business rules + authorization policy)
       → repositories (hand-written SQL via pg)
   ▼
PostgreSQL (Neon), the only stateful component
```

Production hostnames and how the session cookie reaches the API are an open item (§6).

| Component | Choice | Status | Justification |
|---|---|---|---|
| Frontend | React 19, Vite, Tailwind, React Router, TypeScript (incremental) | Kept + TS (D7) | No reason to change the stack |
| Client state | React state and context, with reducers for conversation timelines | Kept approach, restructured (D9, **flexible**) | Enough for one user's conversations; a library is added only if a concrete problem appears (see "Client structure") |
| Backend | Express 5 + Socket.io 4 in one process | Kept, restructured | Layering replaces SQL-in-handlers |
| Client–server contract | TypeScript types for REST payloads and socket events, declared on each side; no shared package initially | New (D7) | Avoids workspace tooling up front; a shared package can be extracted if the two copies drift |
| Database | PostgreSQL on Neon | Kept | Relational data with real integrity and concurrency needs |
| Auth | Server-side sessions, opaque token in an httpOnly cookie, stored in Postgres | Changed (D3) | Revocation, no token readable by JavaScript |
| Validation | Schema validation at every server boundary (zod), plus database CHECK constraints | New dependency (D17) | Declarative schemas replace repeated hand-written checks across all endpoints and socket payloads; database constraints as defense in depth |
| Logging | pino (JSON, request IDs) | New dependency (D17) | Structured logs searchable on Render |
| Security middleware | helmet, express-rate-limit (in-memory store) | New dependencies (D17) | Standard, small, well understood |
| File storage | None | — | No uploads in scope (D12) |
| Background jobs | None. An in-process interval deletes expired sessions and re-checks sockets' sessions | — | One instance; a queue would have nothing to do |
| Caching | None | — | Session lookup is one indexed primary-key query per request; measure before caching |
| Redis | None | — | Needed only for multiple instances (D16). See the future scaling path in §8 |

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
- **State (D9, flexible):**
  - `AuthContext`, driven by `GET /api/auth/me`. No token is ever visible to JavaScript.
  - A conversations context: sidebar list, unread counts and read state.
  - Per-conversation message timelines held in a reducer. The merge, dedupe and pending-reconciliation logic is written as pure functions so it can be unit tested.
  - Contexts are split so that typing in the composer or a presence change does not re-render the message list.
- **When a state library would be justified:** TanStack Query if fetching, caching and refetch logic starts being duplicated across many screens; Zustand or similar if context re-renders cause measured performance problems. Neither is required up front.
- **Real-time:** one socket manager module dispatches socket events into the reducers.
- **HTTP:** Axios stays, with a response interceptor that treats any 401 as logout.

**REST API:**

| Area | Endpoints |
|---|---|
| Auth | `POST /api/auth/signup`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me` |
| Users | `GET /api/users?q=` (username prefix, for DMs and invites; rate limited), `PATCH /api/users/me` |
| Conversations | `GET /api/conversations` (mine, with `lastSeq`, `lastRev`, `lastReadSeq`, `unreadCount`); `GET /api/channels?q=` (public directory); `POST /api/channels`; `POST /api/dms {userId}` (get-or-create, idempotent); `GET`, `PATCH`, `DELETE /api/conversations/:id`; `POST …/:id/join`; `POST …/:id/leave` |
| Members | `GET …/:id/members`, `POST …/:id/members`, `PATCH …/:id/members/:userId` (role), `DELETE …/:id/members/:userId` |
| Messages | `GET …/:id/messages?before=<seq>&limit=`, `GET …/:id/messages/changes?afterRev=` (full D5 model only), `POST …/:id/messages {clientId, content}`, `PATCH /api/messages/:id`, `DELETE /api/messages/:id` |
| Read state | `PUT …/:id/read {seq}` |
| Health | `GET /health/live`, `GET /health/ready` |
| Later (D11) | `GET /api/auth/sessions`, `DELETE /api/auth/sessions/:id` (with the session UI); `GET /api/search?q=&conversationId=` (with search) |

**API conventions:**

- Errors use one envelope: `{ error: { code, message, details? } }`. The codes are defined on the server, and the client keeps a matching list (D7). This fixes audit §4.1 structurally.
- Status codes: 400 for validation failures, 401 for no session, 403 when a member lacks the role, 404 for anything a non-member cannot see, 409 for conflicts, 429 for rate limits.
- No `/v1` prefix, because there is only one client. Compatibility is handled through the contract types plus the protocol-version check (§5).

---

## 4. Target database model

All timestamps are `timestamptz`. IDs are integers (D10): every table uses `integer GENERATED ALWAYS AS IDENTITY`. Note that `pg` returns `bigint` as a JavaScript string, so int4 avoids that trap at this scale.

| Table | Columns and constraints |
|---|---|
| `users` | `id` PK; `username` UNIQUE, CHECK `^[a-z0-9_]{3,32}$` (lowercase, immutable); `email` UNIQUE, CHECK `email = lower(email)`; `display_name` CHECK length 1–50; `password_hash`; `created_at`, `updated_at` |
| `sessions` | `token_hash bytea` PK (SHA-256 of the cookie token); `user_id` FK → users ON DELETE CASCADE; `created_at`; `last_seen_at`; `expires_at`; `user_agent` |
| `conversations` | `id` PK; `type` CHECK in (`channel`, `dm`); `visibility` CHECK in (`public`, `private`); `name` CHECK `^[a-z0-9-]{1,40}$`; `topic`; `created_by` FK → users ON DELETE SET NULL; `last_seq int NOT NULL DEFAULT 0`; `last_rev int NOT NULL DEFAULT 0` (full D5 model only); `last_message_at`; `created_at`, `updated_at`. A table-level CHECK requires channels to have `name` and `visibility`, and DMs to have neither |
| `direct_conversations` | `conversation_id` PK/FK → conversations ON DELETE CASCADE; `user_a_id`, `user_b_id` FK → users; CHECK `user_a_id < user_b_id` (also blocks self-DMs); UNIQUE (`user_a_id`, `user_b_id`) |
| `conversation_members` | PK (`conversation_id`, `user_id`), both FKs ON DELETE CASCADE; `role` CHECK in (`owner`, `admin`, `member`); `last_read_seq int NOT NULL DEFAULT 0`; `joined_at` |
| `messages` | `id` PK; `conversation_id` FK ON DELETE CASCADE; `seq`; `rev` (full D5 model only); `author_id` FK → users ON DELETE RESTRICT; `client_id uuid NOT NULL`; `content`; `created_at`; `edited_at`; `deleted_at`. UNIQUE (`conversation_id`, `seq`); UNIQUE (`author_id`, `client_id`); CHECK `deleted_at IS NOT NULL OR char_length(content) BETWEEN 1 AND 4000` |

**Indexes:**

| Index | Serves |
|---|---|
| `messages` UNIQUE (`conversation_id`, `seq`) | Keyset history pagination and gap fetches |
| `messages` (`conversation_id`, `rev`) | Change feed for catch-up (full D5 model only) |
| `messages` UNIQUE (`author_id`, `client_id`) | Idempotent sends (also covers the `author_id` foreign key) |
| `conversation_members` (`user_id`, `conversation_id`) | "My conversations" and joining rooms on connect |
| `conversations` partial UNIQUE (`name`) WHERE `type = 'channel'` | Unique channel names |
| `sessions` (`user_id`), (`expires_at`) | Session lookup by user; expiry cleanup |
| `messages` GIN (generated `tsvector`) | Full-text search, added later with search (D11) |

**Important decisions:**

1. **Per-conversation counters instead of global ID ordering (D5, flexible).**
   - A global serial ID is allocated at insert, but transactions can commit out of ID order. A catch-up query like `id > X` can therefore permanently skip a message.
   - The send transaction instead increments `conversations.last_seq` (and `last_rev`) with an `UPDATE … RETURNING`. That takes a row lock, so within a conversation the sequence values are assigned in commit order with no gaps. A rolled-back transaction rolls back its increment too.
   - This gives three things: safe catch-up, gap detection on the client, and O(1) unread counts (`last_seq - last_read_seq`).
   - The cost is that sends within one conversation are serialized. That is fine at chat volumes and makes a good discussion point.
   - §5 lists the guarantees that are required regardless, and the simpler mechanisms that may replace this model.
2. **Two counters, `seq` and `rev`.**
   - `seq` is a message's permanent position, used for ordering, pagination and unread counts.
   - `rev` increments on every create, edit or delete. It lets clients fetch "everything that changed since X". That matters because edits and deletions must reach clients that were offline when they happened.
   - `rev` belongs to the full model only. It is added in Phase 5 (initialized from `seq` for existing rows) and skipped if a simpler mechanism is chosen.
3. **One `conversations` table with a type discriminator,** plus a DM side table. Messages, members, rooms and read state all work the same way for every conversation type. DM-only rules (exactly two members, uniqueness) live in `direct_conversations`, where the unique pair constraint resolves concurrent "start DM" requests with `INSERT … ON CONFLICT`.
4. **Soft delete that erases content.** The row stays, which keeps `seq` gapless and keeps the history intact. The content is cleared, which honors the user's intent and is what "delete" should mean for privacy.
5. **Denormalization.**
   - `messages` stores no copy of the username. Author details come from a join on the primary key.
   - `last_seq` and `last_message_at` are the one intentional denormalization. They power sidebar sorting and unread counts without aggregate queries, and are updated in the same transaction as the insert.
6. **Case-insensitivity by normalization plus CHECK constraints,** rather than the `citext` extension. This is simpler and explicit. The constraint guarantees nothing unnormalized gets in.
7. **Constraints mirror the server-side validation limits,** so the database stays consistent even if application code has a bug.

### Starting from a fresh database (D6)

Existing production users and messages are not preserved. The V2 schema is built from scratch by migrations, with no backfill and no legacy-compatibility constraints.

- **Phase 0** adds an initial migration that reproduces the current `users` and `messages` tables. It exists only so the existing single-room code and the Phase 0 tests have a schema to run against.
- **Phase 1** replaces those tables with the V2 schema above.
  - The old tables are dropped, not migrated. No database holds data that must be kept.
  - Local databases can be reset at any time.
- **Keeping the single-room app working until Phase 4:**
  - Phase 1 seeds one public channel, `#general`.
  - The single-room code is updated to read and write `#general`, assigning `seq` and a server-generated `client_id`, joining `users` for author names, and adding new users as members.
  - Signup applies the new username and email rules.
- **First production deploy of the V2 schema:**
  - Point the server at a fresh, empty database, either a new Neon database or the existing one reset, and run the migrations.
  - Rotate `JWT_SECRET` at the same time. User IDs restart at 1, so a token issued against the old database could otherwise match a different new user.
  - No backup is needed, and the old database can be deleted afterwards.

---

## 5. Real-time architecture

### Reliability guarantees and D5 flexibility

These guarantees are **required** whichever mechanism is used:

1. Order within a conversation is assigned by the server and is the same for every client.
2. A retried send never creates a duplicate and never loses the user's text.
3. The client never shows the same message twice. It dedupes by `id`, and by `clientId` for its own pending sends.
4. After a reconnect, the client catches up on the new messages, edits and deletes it missed.
5. The initial page load cannot lose or duplicate messages (audit §4.3).

The **mechanism is flexible (D5)**:

| Level | Mechanism | When it is used |
|---|---|---|
| Full (preferred) | `seq` and `rev` counters, gap detection, and the `…/changes?afterRev=` feed | By default |
| Simplified | `seq` only. On reconnect, reload the latest page of each open conversation and discard older cached pages; older pages are fetched again on scroll | If the change feed or gap detection proves disproportionately difficult |
| Minimal | No counters. Order and paginate by `id`, and catch up by reloading the latest page, never with `id > X`, because transactions can commit out of ID order. Unread counts use a `COUNT(*)` against a read marker | Only if per-conversation counters themselves prove impractical |

The level is chosen during Phases 4–5 and recorded in an ADR. The rest of this section describes the full model and notes where the simpler levels differ.

### Rooms

| Room | Members | Used for |
|---|---|---|
| `conv:{id}` | Sockets of all members | Message events, conversation and member events, typing, presence |
| `user:{id}` | All of one user's sockets (every tab and device) | Read-state sync, added to or removed from a conversation |
| `session:{hash}` | Sockets of one session | Immediate disconnect on logout or revocation |

Membership changes call `io.in('user:X').socketsJoin/socketsLeave('conv:Y')` (Socket.io 4 APIs). A removed member stops receiving messages immediately, in every tab. Inside socket handlers, `socket.rooms` doubles as a membership cache that is always current, for example to authorize typing events.

### Events

Events are typed with Socket.io's event-map generics. Each side keeps its own copy of the event types (D7).

| Direction | Event | Target | Payload |
|---|---|---|---|
| S→C | `message:created`, `message:updated` | conv room | The full message state, including `seq` (and `rev` in the full model). Edits and deletes use `updated`; a delete arrives as the full message with `deletedAt` set and content cleared |
| S→C | `conversation:joined`, `conversation:left` | user room | Conversation summary / `{conversationId, reason}` |
| S→C | `conversation:updated`, `member:joined`, `member:left` | conv room | Changed state |
| S→C | `read:updated` | user room | `{conversationId, lastReadSeq}` |
| S→C | `typing` | conv room, except the sender | `{conversationId, userId}` |
| S→C | `presence:updated` | the user's conv rooms | `{userId, online}` |
| S→C | `session:revoked` | session room | Sent just before the server disconnects those sockets |
| C→S | `typing` | — | `{conversationId}`; throttled; no acknowledgement |

With REST writes (D2), `typing` is the only client-to-server event.

Events carry full state rather than deltas. This makes applying them idempotent: the client keeps a message only if the incoming `rev` is higher than the one it has. Duplicates and out-of-order arrivals then converge to the same state without special handling. Without `rev`, updates are applied by message `id` in arrival order, and the reload after a reconnect corrects any stale state.

### Connection lifecycle

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

### Message delivery (REST write path)

1. **Local pending state.** The composer generates a `clientId` (UUID) and shows the message as *pending*.
2. **Request.** The client sends `POST /messages {clientId, content}`.
3. **Server transaction.** The server validates, applies the rate limit and authorizes membership. Then, in one transaction, it:
   - increments the conversation counters (which takes the row lock);
   - inserts the message, guarded by a membership `EXISTS` check so that a concurrent removal cannot slip a message through;
   - advances the sender's `last_read_seq`.

   After **commit** it emits `message:created` and returns 201. Events are never emitted inside the transaction.
4. **Reconciliation.** The client matches its pending message by `clientId`, using whichever arrives first: the HTTP response or the socket echo.
5. **Failure handling.** On a network error or 5xx, the message is marked *failed* and its text is kept. Retry resends the same `clientId`. If the first attempt actually committed, the unique constraint makes the server return the existing message with 200, so there is no duplicate. This fixes audit §4.5.
6. **Failure between commit and emit.** The message is stored but not broadcast. Other clients pick it up when they next reconnect and, in the full model, as soon as the next event reveals a `rev` gap. A server crash drops every socket, so all clients reconnect and catch up.

This gives **at-least-once delivery through pull-based repair.** Socket delivery is best-effort; correctness comes from the database.

### Sync and catch-up procedure

1. `GET /api/conversations` reconciles the sidebar: added or removed conversations, `lastSeq`, `lastRev` and unread counts.
2. For each conversation with loaded messages where the server's `lastRev` is ahead of the local one, the client fetches `GET …/changes?afterRev=` and applies the results as upserts.
3. If the change set is very large, the client discards that conversation's cache and reloads the latest page. This bounds the work after long disconnects.
4. Live events that arrive during sync are applied normally. Because application is idempotent, the order does not matter.
5. At any time, an event whose `rev` is greater than local `lastRev + 1` triggers the same repair.

In the simplified and minimal levels, step 2 is replaced by reloading the latest page, and step 5 does not apply.

This removes the page-load race (audit §4.3) instead of trying to time around it: the socket connects first, and the REST page and live events merge correctly in any order.

Socket.io's built-in *connection state recovery* is not used. It keeps missed packets in memory only, does not survive restarts or deploys, and would add a second recovery path alongside the one that is needed anyway.

### Presence

- An in-memory map of `userId → Set<socketId>`. A user is online from their first socket and offline once they have zero sockets for about 15 seconds, so page refreshes do not flicker.
- Changes are broadcast with `io.to([...their conversation rooms])`. Socket.io delivers once per socket even when that socket is in several of the rooms.
- The initial snapshot comes with the members and DM list responses.
- Online/offline only. No "last seen", which avoids a persistence and privacy question.
- This is **explicitly single-instance (D16).** It is the first thing that breaks when a second instance runs; see the future scaling path in §8.

### Typing

- The client emits `typing` at most every 3 seconds while composing.
- The server checks that the socket is in `conv:{id}`, drops events beyond the throttle, and relays the event.
- Receivers show the indicator for about 5 seconds unless it is refreshed, and ignore their own `userId`.
- The server holds **no typing state.** That fixes the audit §5 bug where closing one tab cleared the indicator for another, and it works unchanged with multiple instances.

### Read state

- When a conversation is visible, focused and scrolled to the bottom, the client sends `PUT /read {seq}`, debounced.
- The server applies `last_read_seq = GREATEST(last_read_seq, $seq)`, so updates are monotonic and concurrent tabs cannot move the position backwards. It then emits `read:updated` to the user room.
- Per-message "Seen" receipts are optional and not planned.

### Multiple tabs and devices

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

### Authentication (D3): server-side sessions

The options that were compared:

| Option | Token theft via XSS | Revocation | CSRF exposure | Complexity | Split-domain deploy |
|---|---|---|---|---|---|
| Current: JWT in `localStorage`, 7 days | Readable | None | None | Low | Works |
| JWT in an httpOnly cookie | Not readable | None without a denylist, which reintroduces state | Yes | Low | Needs a same-site setup |
| Short access JWT plus rotating refresh cookie | Refresh token not readable | On refresh only (minutes of delay) | Refresh endpoint | **High** (rotation, reuse detection, two code paths) | Needs a same-site setup |
| **Server-side session** (opaque token in httpOnly cookie, stored in Postgres) — **chosen** | Not readable | Immediate | Yes (mitigated below) | Low–Med | Needs a same-site setup |

Why sessions:

- JWT's real advantage is verification without a database lookup, which matters across many services. Relay has one service that already queries the database on every request.
- A revocation requirement puts state back into a JWT design anyway, at which point sessions are simpler.
- What httpOnly buys, precisely: XSS can still *act as the user* while the page is open, but it can no longer *steal a token* and use it elsewhere. React's escaping and a CSP remain the actual XSS defenses.

**Session details (defaults):**

- The token is 32 random bytes. Only its SHA-256 hash is stored, so a database leak does not yield usable sessions.
- Cookie in production: `__Host-relay_session`, `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`. Cookie attributes are configurable per environment, because browsers differ on accepting `Secure` cookies over `http://localhost` (verify per browser).
- Expiry: 7-day idle timeout (sliding, with `last_seen_at` updates throttled), 30-day absolute limit.
- A new session is created on every login.
- Logout deletes the session row and disconnects that session's sockets.
- An in-process sweep every few minutes checks all connected sockets' sessions in one query and disconnects any that are no longer valid. This fixes audit §7.8.

### Cookie topology (decided in Phase 2: option 2; D4 still deferred)

**Decided 2026-09-28 (`docs/phase-2-implementation-plan.md` §16, `docs/adr/0005-production-cookie-topology.md`): option 2, serving the SPA from Express**, because it costs nothing. Socket.io uses WebSockets only, so every handshake carries the `Origin` that the handshake check needs. The analysis that led there:


- **Local development works as is.** `localhost:5173` and `localhost:5001` are the same site, because ports do not affect site, so `SameSite=Lax` cookies are sent.
- **Production needs a choice.** `*.vercel.app` and `*.onrender.com` are different sites, so the session cookie would be a third-party cookie. Safari blocks those by default.
- Before cookie authentication is deployed to production (Phase 2), one of the options already identified must be chosen:
  1. A custom domain with `app.` and `api.` subdomains, which makes client and API same-site. This is the option deferred under D4.
  2. Serving the SPA from Express, so client and API share one origin. No CORS and no domain are needed, but the client leaves Vercel.
  3. `SameSite=None` cross-site cookies. Not acceptable, because Safari users could not log in.
- Until then, development and CI are unaffected, and production can stay on the last release deployed before Phase 2.

### CSRF

- `SameSite=Lax` blocks cross-site POSTs from carrying the cookie.
- The server also checks the `Origin` header on every state-changing request.
- Requiring `Content-Type: application/json` forces a preflight that CORS then denies.

These three layers are cheap and easy to explain.

### Authorization

- A single `policy` module with rules like `canPost`, `canEditMessage`, `canDeleteMessage` and `canManageMembers`, called only from services.
- Reading requires membership, including for public channels (D14).
- Private conversations and non-members get **404, not 403,** so their existence is not leaked.
- A test suite covers the full permission matrix.

| Action (channels) | Non-member (public) | Member | Admin | Owner |
|---|---|---|---|---|
| Read and post | Join first | ✓ | ✓ | ✓ |
| Edit or delete own messages | — | ✓ | ✓ | ✓ |
| Delete others' messages | — | — | ✓ | ✓ |
| Add members (private channel) | — | — | ✓ | ✓ |
| Remove members | — | — | ✓ (not owner) | ✓ |
| Change roles, delete channel | — | — | — | ✓ |

Nobody can edit another user's message. DMs have exactly two members and no roles. Members cannot leave or add people. Owners must transfer ownership before leaving.

### Rate limits

Basic limits (D15), with an in-memory store, which is acceptable on one instance:

| Surface | Key | Limit (starting point) |
|---|---|---|
| Login | IP + email | ~10 per 15 min |
| Signup | IP | ~5 per hour |
| Message send and edit | user | ~20 per 10 s, returns 429 with `Retry-After` |
| DM and channel creation, user search | user | Modest per-minute caps |
| Socket `typing` | user + conversation | 1 per 2 s, excess dropped silently |

Express must set `trust proxy` to Render's actual proxy depth. Otherwise the client can spoof `X-Forwarded-For` and bypass IP limits, or every user shares the proxy's IP. The correct hop count needs to be verified.

### Other controls

1. **Validation:**
   - Schema validation on every body, query, parameter and socket payload.
   - Message length 1–4000 characters after trimming.
   - `express.json({ limit: '16kb' })`.
   - Socket.io `maxHttpBufferSize` around 8 KB. This is safe because clients only send typing events over the socket, which is another benefit of REST writes.
2. **Passwords:**
   - Enforced server-side: at least 8 characters and at most 72 bytes (bcrypt's limit), rejected rather than silently truncated.
   - Login compares against a dummy hash when the email is unknown, so response timing does not reveal registered emails (fixes audit §7.4).
3. **Enumeration:**
   - Usernames are public by design.
   - Signup cannot fully hide whether an email is taken without email verification, which is out of scope. This is an accepted residual risk, reduced by rate limiting.
4. **Headers:**
   - helmet on the API.
   - A CSP on the SPA (via `vercel.json` while the client is on Vercel): `default-src 'self'`, `connect-src` limited to the API origin over HTTPS and WSS, `frame-ancestors 'none'`.
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
| Unit | Vitest | Policy rules, validation schemas, and the client reducer functions (merge, dedupe, pending reconciliation; gap detection in the full D5 model) |
| API integration | Vitest + supertest against real Postgres | Every endpoint; the **full authorization matrix**; error envelope; rate limits |
| Database behavior | Same | Concurrent sends to one conversation produce gapless `seq` (if counters are used); concurrent DM creation yields one conversation; idempotent retry; constraints reject bad data |
| Migration | Same | Migrations apply cleanly to an empty database, which is how every test run starts |
| Socket integration | Server on an ephemeral port + `socket.io-client` | Non-members receive nothing; removed members stop receiving immediately; revoked sessions are disconnected; bad Origin rejected; typing relay and throttle; outdated protocol rejected |
| Component | React Testing Library, only if component tests prove worthwhile (D17) | Composer failure and retry states, unread badges |
| E2E | Playwright, about 6–8 flows | Two browser contexts exchanging messages; going offline and back online, then catching up; failed send and retry; editing and deleting while another client is offline; removal from a private channel; logout in one tab |

**Test database:** one Postgres instance (Docker Compose locally, a service container in CI), migrated once, with tables truncated before each test. This is preferred over wrapping each test in a rolled-back transaction, because the concurrency tests need real, separate transactions.

Coverage goals are about behavior (every policy rule and every sync path), not a percentage.

**TypeScript (D7):**

- `client` and `server` each get their own `tsconfig` with `allowJs`, and typecheck runs in CI. There are no npm workspaces and no shared package initially.
- REST and socket payload types are declared on each side. Integration and E2E tests catch drift between the two copies. If drift becomes a real problem, a shared package is extracted then.
- New code is written in TypeScript. Existing files are converted when they are rewritten anyway. Converting the single-room socket handler first would be wasted work, since it gets replaced.
- Strict mode, with no JavaScript remaining, is a completion criterion of the final phase.
- Server: `tsx` in development, `tsc` builds for production.

**Migrations and data access (D8):**

- Plain SQL migration files under version control, applied in order by a runner that records which files have run and takes an advisory lock. The runner is either a small script or a lightweight tool; the choice is made in the Phase 0 plan (D17).
- Queries stay hand-written SQL in repositories. No ORM or query builder.
- Run migrations over Neon's **direct (unpooled) connection.** The pooler's transaction mode does not reliably support session-level advisory locks; verify this for the Neon setup in use.
- Rule: **expand, then contract.** Every migration must work with both the currently deployed server and the new one, because the two overlap during deploys and old tabs stay open. The one exception is Phase 1, which moves to a fresh database instead of migrating the old one (§4).

**Reliability basics:**

- A `pool.on('error')` handler (fixes audit §4.2).
- A global Express error handler and a JSON 404 handler.
- A typed `AppError` carrying `code` and `status`.
- Graceful shutdown on SIGTERM: stop accepting connections, close Socket.io, drain the pool.
- `/health/live` (process is up) and `/health/ready` (database answers `SELECT 1`).
- pino with a request ID per request, plus socket lifecycle logs.
- An ESLint configuration for the server.
- Short ADRs in `docs/adr/` for the significant decisions, including which D5 level was implemented and whether D9 needed a library. They are cheap to write and directly useful for interviews.

---

## 8. Deployment strategy

**Topology (D13 deferred; the D4 cookie question decided in Phase 2):**

- From the Phase 2 release, Render runs one web service that serves the API, the sockets and the built SPA from one origin (§6, ADR 0005); the old Vercel URL redirects there. Neon hosts Postgres. Until then, Vercel serves the SPA.
- The custom domain is deferred (D4), and hosting-plan decisions are deferred until deployment (D13).
- Vercel rewrites are believed not to proxy WebSockets, which would rule out using them as a shortcut to a single origin. Verify before relying on it either way.

**Environments:** local (Docker Compose Postgres), CI (ephemeral Postgres), production. No staging environment, to keep cost down; Neon branches could provide one later if needed.

**CI (GitHub Actions)**, on every pull request, as required checks:

1. Lint and typecheck.
2. Unit tests.
3. Integration, migration and socket tests with a Postgres service container.
4. Build.
5. Playwright E2E, once introduced.

**CD:**

1. Merging to `main` triggers the deploys.
2. Render deploys after CI passes. Render's "wait for CI checks" auto-deploy setting and its pre-deploy command may depend on the plan; check both when the plan is chosen (D13).
3. Migrations run before the new server starts, either as a pre-deploy command or at startup under the advisory lock.
4. Vercel deploys the client automatically.
5. Vercel preview deployments cannot use cookie authentication against the production API, because preview URLs are on a different site. Use them only for UI review, or disable them.

**Hosting plan (deferred, D13).** Facts to use when it is decided:

- On the free Render tier, the instance sleeps when idle. That drops every socket, and the first visitor waits through a cold start, which is a poor first impression for a recruiter.
- An always-on paid instance avoids this; check current pricing at that time.
- Neon's free tier is likely sufficient.

**Deploy continuity:**

- Clients reconnect and sync after every deploy, so a restart becomes a brief gap that is repaired automatically, not data loss.
- Whether Render overlaps the old and new instances during a deploy is unverified (audit §12). The expand/contract rule and the protocol-version check make either behavior safe.

**Future scaling path (documented, not implemented; D16).** Running a second instance would require:

- A shared Socket.io adapter so that `io.to(room)` reaches sockets on every instance: either the Postgres adapter, which uses LISTEN/NOTIFY and therefore needs Neon's direct connection rather than the pooler, or the Redis adapter.
- Presence moved from process memory to a shared store.
- A shared store for rate-limit counters.
- Sticky sessions at the load balancer, if Socket.io's HTTP long-polling transport stays enabled.

These parts would keep working unchanged: message ordering and catch-up (owned by Postgres), the typing relay (stateless), session checks (Postgres), and the session sweep (safe to run on every instance).

---

## 9. Implementation roadmap

Each phase leaves the app working and CI green. Phases 0 and 1 can go to production as soon as they are done. Phase 2 onward reaches production through Phase 2's release, which also moves production to the chosen cookie topology (§6); until then, those phases are verified locally and in CI.

### Phase 0 — Foundation (on the existing single-room app) — ✅ complete

- **Status:** completed 2026-09-27, as scoped by the lean plan in `docs/phase-0-implementation-plan.md` (completion record in its §16). That plan deferred Prettier, health checks and audit §4.8, limited tests to the behavior V2 relies on, and moved audit §4.7 to Phase 1.
- **Goal:** a safe base for change.
- **Changes:**
  - TypeScript tooling in `client` and `server` (separate `tsconfig` files, `allowJs`); ESLint and Prettier on the server.
  - Vitest, supertest, Docker Compose Postgres, the SQL migration runner, and an initial migration that reproduces the current schema (§4, "Starting from a fresh database").
  - CI.
  - Env validation, pool error handler, error envelope (with the matching client fix), global error handler, 404 handler, graceful shutdown, pino, health checks.
  - Remove dead files and fix the README.
  - Fix audit §4 items 1, 2, 6, 7, 8 and 9. Items 3–5 are fixed structurally in Phases 4–5 rather than patched twice.
  - The detailed, authoritative scope is `docs/phase-0-implementation-plan.md`.
- **Dependencies:** none.
- **Tests:** characterization tests of the current auth, messages and socket behavior.
- **Done when:** CI is green on every PR, current behavior is covered by tests, and the fixes are deployed.

### Phase 1 — Data model (fresh database, D6) — ✅ complete, in production

- **Status:** completed 2026-09-27 on the long-lived `phase-1` branch, as planned in `docs/phase-1-implementation-plan.md` (completion record in its §15), and put in production the same day by the cutover in that plan's §13: a new Neon database, a rotated `JWT_SECRET`, and `phase-1` merged into `main`. Decisions are recorded in `docs/adr/`: `0002` replaces the Phase 0 tables (ADR 0001), int4 identity IDs (ADR 0002), and `seq` with a row-lock counter now, with `rev` left to the Phase 5 decision point (ADR 0003). Emails are limited to 100 characters.
- **Goal:** the V2 schema, built from scratch.
- **Changes:**
  - Migrations that drop the Phase 0 tables and create the V2 tables from §4: `users`, `conversations`, `direct_conversations`, `conversation_members` and `messages` (with `seq`). `sessions` follows in Phase 2.
  - Seed the `#general` channel. The single-room code is updated to use the new tables (§4), so the app keeps working.
  - If deployed: a fresh production database and a rotated `JWT_SECRET` (§4).
  - Carried over from Phase 0: audit §4.7 (an over-length username returns 500), fixed by server-side signup validation with the new username and email rules.
- **Dependencies:** Phase 0 (complete); D10. Open questions for the Phase 1 plan are listed in `docs/phase-0-implementation-plan.md` §17.
- **Tests:** migrations apply to an empty database; constraint tests (username and email format, content length, the DM pair rule, the channel/DM shape check); the Phase 0 tests updated to the new schema.
- **Done when:** local and CI databases are built by the new migrations, the single-room app works on the V2 schema, and every constraint is covered by a test. If the minimal D5 level is chosen later, `seq` is dropped in a later migration.

### Phase 2 — Sessions and security baseline — ✅ complete (release pending)

- **Status:** completed 2026-09-28 on the long-lived `phase-2` branch (draft PR #2), as planned in `docs/phase-2-implementation-plan.md` (decisions in its §16, completion record in its §17). It reaches production through that plan's release runbook (§15). Decisions are recorded in ADR 0004 (server-side sessions and the three CSRF layers) and ADR 0005 (the SPA served by Express, WebSocket only). Signups are limited to 20 per hour per IP instead of 5, so a demo to a group on one network is not blocked.

- **Goal:** revocable authentication.
- **Changes:**
  - Sessions table, cookie auth, `/me`, logout.
  - Origin and CSRF checks; socket handshake authenticated by cookie with an Origin check; session rooms and the periodic sweep.
  - Password rules and the timing fix; basic auth rate limits; helmet; `trust proxy`.
  - Client: remove `localStorage` token handling, add the 401 interceptor.
- **Dependencies:** Phase 1. **The production cookie topology (§6) must be chosen before this phase is deployed to production.**
- **Tests:** auth API and CSRF tests; socket rejects missing or revoked sessions; logout disconnects the session's sockets.
- **Done when:** no token is readable by JavaScript and logout cuts off live sockets.

### Phase 3 — Conversations and authorization (vertical slice)

- **Goal:** channels, DMs and memberships end to end.
- **Changes:**
  - Service, repository and policy layers.
  - Conversation, channel, DM and member endpoints.
  - Room joins on connect; live `socketsJoin`/`socketsLeave`; `conversation:*` and `member:*` events.
  - Client: routing, sidebar, channel browser, create and invite flows, conversation state in React context (D9).
- **Dependencies:** Phases 1 and 2.
- **Tests:** the full authorization matrix; the concurrent DM-creation race; a non-member receives nothing.
- **Done when:** users can create, join and leave conversations, and every permission rule is tested.

### Phase 4 — Messaging in conversations

- **Goal:** per-conversation messaging with ordering guarantees.
- **Changes:**
  - Send endpoint with the counter transaction and `clientId` idempotency.
  - Keyset pagination; `message:created` to rooms.
  - Client: `Chat.jsx` decomposed, reducer-based timeline state, pending/confirmed/failed states, retry, load-older.
  - Remove the single-room API and events.
- **Dependencies:** Phase 3.
- **Tests:** parallel sends produce gapless `seq`; retry does not duplicate; removed members stop receiving; pagination edges.
- **Done when:** audit issues §4.3 and §4.5 cannot be reproduced.

### Phase 5 — Sync and resilience

- **Goal:** correctness through disconnects.
- **D5 decision point:** implement the full model (`rev`, the changes endpoint, gap detection) or one of the simpler levels in §5, and record the choice in an ADR.
- **Changes:** catch-up on connect for the chosen level; protocol-version handshake; handling of events that arrive during sync.
- **Dependencies:** Phase 4.
- **Tests:** unit tests of the merge logic with shuffled and duplicated events; socket tests with dropped events; Playwright offline/online test; a server restart during an active chat.
- **Done when:** audit issue §4.4 cannot be reproduced, a restart mid-conversation loses nothing, and all five guarantees in §5 hold.

### Phase 6 — Awareness

- **Goal:** unread counts, read state, typing, presence.
- **Changes:** read endpoint with `GREATEST`; `read:updated`; unread computed from counters; stateless typing relay; presence map with a grace period.
- **Dependencies:** Phase 5.
- **Tests:** cross-tab read sync; monotonic read under concurrent updates; multi-tab presence; typing throttle.
- **Done when:** the audit §5 presence and typing issues are resolved.

### Phase 7 — Message editing, deletion and moderation

- **Goal:** editing and deletion (D11) and channel moderation.
- **Changes:** PATCH and DELETE message endpoints (which bump `rev` in the full model); `message:updated`; edit and delete in the UI; admin deletes and member removal in the UI.
- **Dependencies:** Phase 5, because offline clients rely on catch-up.
- **Tests:** a client that was offline during an edit or delete sees the result after reconnecting; policy tests for editing own messages and deleting others' messages.
- **Done when:** edits and deletes reach every client, including ones that were offline.

### Phase 8 — Hardening and launch

- **Goal:** production-ready and portfolio-ready.
- **Changes:**
  - Remaining rate limits and the CSP.
  - Strict TypeScript everywhere.
  - A security checklist review against §6.
  - An architecture document, ADRs, and the future scaling path (§8).
  - Deployment decisions deferred under D4 and D13, if still open.
  - Optionally, seeded demo data (D15) and a small socket load script so any scaling claims are measured rather than guessed.
- **Dependencies:** all prior phases.
- **Tests:** the full E2E suite; the security checklist.
- **Done when:** a stranger can open the deployed app and use it, and every resume claim is backed by code or a test.

### Later (not scheduled)

- **Search (D11):** generated `tsvector` column, GIN index, a search endpoint joined against memberships, and search UI. Tests must show it never returns results from conversations the user cannot access, and `EXPLAIN` must confirm the index is used.
- **Session management UI (D11):** list and revoke other sessions, with the endpoints listed in §3.
- **Custom domain (D4),** if it is not adopted as the cookie topology.
- **Attachments and avatars (D12).**

---

## 10. Decision record

All decisions were approved on 2026-09-27.

| # | Decision | Approved outcome | Where it shows up |
|---|---|---|---|
| D1 | Conversation types | Public channels, private channels and 1:1 DMs | No ad hoc group DMs (§1, B) |
| D2 | Write path | REST writes + Socket.IO push | `typing` is the only client-to-server event (§5) |
| D3 | Auth model | Server-side sessions with secure httpOnly cookies | JWT removed (§6) |
| D4 | Custom domain | Deferred | The production cookie topology was decided in Phase 2 without it: the SPA is served by Express (§6, ADR 0005) |
| D5 | Ordering and sync | **Flexible.** Per-conversation `seq`/`rev` if practical | The guarantees in §5 are required; the mechanism may be simplified or skipped |
| D6 | Existing data | Not preserved; V2 starts with a fresh database (revised 2026-09-27) | Fresh-database approach (§4), Phase 1 |
| D7 | TypeScript | Incremental; no shared package initially | Contract types on each side (§3, §7) |
| D8 | Data access and migrations | SQL-first migrations and raw SQL | No ORM or query builder; runner chosen in Phase 0 (§7) |
| D9 | Client state | **Flexible.** Simple React state and context first | TanStack Query or Zustand only if justified (§3) |
| D10 | IDs | Integer IDs | int4 throughout (§4) |
| D11 | Scope additions | Message editing included; search and session UI later | Phase 7; "Later" list (§9) |
| D12 | Attachments and avatars | Deferred | Initials instead of avatars |
| D13 | Hosting plan | Deferred until deployment | Facts recorded in §8 |
| D14 | Reading public channels | Users must join first | "Read requires membership" (§6) |
| D15 | Access | Open signup + basic rate limiting; demo data optional | §6; Phase 8 |
| D16 | Scale | Single server instance, no Redis | Future scaling path (§8) |
| D17 | Dependencies | Minimal; libraries only when justified | Table below |

**Dependencies (D17):**

| Dependency | Status | Justification |
|---|---|---|
| zod | Planned (Phase 0) | Validation of every REST body, query, parameter and socket payload |
| pino | Planned (Phase 0) | Structured JSON logs with request IDs |
| typescript, tsx | Planned (Phase 0) | D7 |
| vitest, supertest | Planned (Phase 0) | Unit, API, migration and socket integration tests |
| SQL migration runner | Phase 0 | A small script or a lightweight tool (D8) |
| helmet, express-rate-limit | Added (Phase 2) | Security headers and rate limiting are easy to get subtly wrong by hand |
| Playwright | Planned (Phase 4) | Multi-tab and reconnect behavior can only be tested in real browsers |
| React Testing Library | Only if needed | Component tests are selective |
| TanStack Query, Zustand | Only if needed | Triggers in §3 (D9) |
| ORM or query builder | Not planned | D8 |
| Redis, queues, object storage, search engine | Not planned | D12, D16 |

**Defaults (adjustable):**

- 4000-character message limit.
- Sessions: 7-day idle timeout, 30-day absolute limit.
- Presence grace period of about 15 seconds.
- Immutable, lowercase usernames; slug-style channel names.
- DMs cannot be left; owners must transfer ownership before leaving.
- Soft delete with content erased.

### Rationale for the key decisions

#### D2: REST writes vs socket writes

- **Problem:** audit §11 shows REST and sockets already drift apart. Each extra write path duplicates validation, authorization and rate limiting.
- **Alternatives:** socket emits with acknowledgements (the current pattern, one connection, slightly lower latency), or REST for all writes with sockets for push and ephemeral signals only.
- **Tradeoffs:** REST adds per-request HTTP overhead, which is negligible with keep-alive at chat volumes. In return it gives standard status codes, idempotency, supertest-testable writes, middleware-based rate limiting, and a socket that almost only receives. That makes socket security much smaller: only typing is accepted from clients.
- **Interview defense:** "Persistence and authorization happen in one place. The socket is a notification channel, and correctness never depends on it. This is the same split several production chat systems use: writes through an HTTP API, delivery over a WebSocket."

#### D3: Server-side sessions vs JWT

- **Problem:** the current token cannot be revoked, is readable by any script on the page, and logging out does not disconnect sockets.
- **Why sessions fit Relay:** there is one service and it already queries the database, so JWT's stateless benefit is not used, while revocation is required.
- **Interview defense:** be able to answer "wouldn't JWT scale better?" Stateless verification helps when many services must verify tokens without a shared store. At Relay's scale, a primary-key lookup is microseconds. If it ever mattered, a cache in front of the sessions table would be the first step, not rotating refresh tokens.

#### D5: Per-conversation sequence and revision (flexible)

- **Problem:** with global ID ordering, transactions can commit out of ID order, so "fetch everything after ID X" can skip messages. Separately, edits and deletions have to reach clients that were offline.
- **Choice:** counters on the conversation row, incremented under a row lock inside the send transaction, if practical. The simpler levels in §5 keep the same guarantees with less machinery.
- **Tradeoff:** writes within one conversation are serialized: roughly hundreds of sends per second per conversation, far beyond Relay's needs.
- **Interview defense:** walk through the commit-order problem, show how the row lock makes sequence numbers gapless, and explain why gaplessness makes client-side gap detection possible. If a simpler level was used, explain which guarantee each part of it provides and what the full model would add.

---

## Next steps

1. ~~Implement Phase 0~~ — done 2026-09-27 (`docs/phase-0-implementation-plan.md`, §16).
2. ~~Write and approve `docs/phase-1-implementation-plan.md` and implement Phase 1~~ — done 2026-09-27 on the `phase-1` branch (that plan's §15).
3. ~~Run the Phase 1 production cutover~~ — done 2026-09-27 (the Phase 1 plan's §15).
4. ~~Write and approve `docs/phase-2-implementation-plan.md`, choose the production cookie topology and implement Phase 2~~ — done 2026-09-28 on the `phase-2` branch (that plan's §17).
5. **Release Phase 2** when the maintainer decides, following the Phase 2 plan's §15.
6. **Write and approve `docs/phase-3-implementation-plan.md`** before any Phase 3 code (handoff in the Phase 2 plan's §18). The scope of Phases 3–8 is to be revisited first: Relay is a portfolio project on free tiers.
