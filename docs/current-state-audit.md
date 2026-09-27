# Relay — Current-State Audit

Read-only audit of the repository at commit `2e72c1d`. Line numbers refer to that commit and will drift as code changes.

> **Historical snapshot.** This describes the app before Phase 0. Phase 0 (completed 2026-09-27) fixed audit §4 items 1, 2, 6 and 9 and the port mismatch, and added migrations, tests, CI and logging; see `docs/phase-0-implementation-plan.md` §16 for what changed and what remains open.

**How to read this document**

- Unmarked statements are **verified**: they were confirmed by reading the source, running `eslint`, checking installed library code in `node_modules`, or inspecting git history.
- Statements marked *(inferred)* are architectural implications drawn from verified facts, or assumptions about external services, that were not tested.
- Anything about production that cannot be determined from the repository is listed in [§12 Unknowns](#12-unknowns).

---

## 1. Executive Summary

Relay is a small (~1,200 lines), working single-room chat prototype: Express 5 + Socket.io 4 + PostgreSQL on the server, React 19 + Vite + Tailwind 3 on the client.

- The code is clean and readable, but there are no tests, no schema migrations, no rooms, and no deployment configuration in the repository.
- The single-room assumption runs through every layer: the schema, the REST API, the socket events and the client state. Turning Relay into a multi-conversation platform is a redesign of those layers, not an incremental feature addition *(inferred)*.
- There are several confirmed correctness bugs (§4). The most serious is an unhandled `pg` pool error that can crash the server process.
- There are security gaps (§7), chiefly the absence of rate limiting and server-side input limits.

---

## 2. Current Architecture

### Repository structure

- Two independent npm projects, `server/` and `client/`. There is no root `package.json` and no workspaces.
- Plain JavaScript (ES modules) throughout. No TypeScript, no shared code between client and server.
- No CI configuration, no `render.yaml`, no `vercel.json`, no Dockerfile.
- Installed versions: express 5.2.1, socket.io 4.8.3, pg 8.21.0, bcrypt 6.0.0, react 19.2.7, socket.io-client 4.8.3, vite 8.0.16.

### Backend (`server/`)

- One process (`server/index.js`) runs Express and Socket.io on a single `http.Server` (`server/index.js:36-46`).
- CORS allows exactly one origin, `CLIENT_URL` (`server/index.js:21-27`, `38-44`).
- There is no service or data-access layer. Route handlers and socket handlers issue SQL directly against the shared `pg` Pool in `server/db/connection.js`.
- Environment variables are loaded from a `.env` file at the repository root. `DATABASE_URL`, if set, takes precedence over the individual `DB_*` variables (`server/db/connection.js:13-24`).

### Database

- There are two tables, `users` and `messages`. Their schema exists **only in `README.md`**; there are no migrations or schema files in the repository.
- `messages` has `user_id` (a foreign key to `users`), a denormalized copy of `username`, `content TEXT`, and `created_at TIMESTAMP` (without time zone).
- IDs are `SERIAL` integers. There is no concept of rooms, channels or membership.
- Beyond primary keys and unique constraints, no indexes are defined in the README schema.

### REST API

| Endpoint | Location | Notes |
|---|---|---|
| `POST /api/auth/signup` | `server/routes/auth.js:10-54` | Returns `{ token, user }` |
| `POST /api/auth/login` | `server/routes/auth.js:57-94` | Returns `{ token, user }` |
| `GET /api/messages` | `server/routes/messages.js:9-37` | Protected. Always returns the latest 50 messages, oldest first. Takes no parameters. |
| `GET /api/ping` | `server/index.js:32` | Does not check the database |

Errors are returned as `{ error: string }`.

### Socket.IO (`server/socket/socketHandler.js`)

- Every broadcast goes to all connected sockets (`io.emit` / `socket.broadcast.emit`). Socket.io rooms are not used.
- Typing timers are kept in an in-memory `Map` keyed by user ID (`socketHandler.js:9`).

| Direction | Event | Payload |
|---|---|---|
| Client → server | `new_message` | `{ content }`. No acknowledgement is sent back. |
| Client → server | `typing` | none |
| Server → client | `message` | `{ id, userId, username, content, createdAt }` |
| Server → client | `online_count` | `io.sockets.sockets.size`, which counts sockets in this process only |
| Server → client | `user_typing` / `user_stop_typing` | username string |
| Server → client | `error` | `{ message }`, sent only to the sender |

### Authentication and authorization

- Signup and login issue a JWT containing `{ id, username }` that expires after 7 days (`server/routes/auth.js:39-43`, `82-86`). Passwords are hashed with bcrypt at cost 10.
- The token is checked in two separate places: the HTTP middleware (`server/middleware/verifyToken.js`) and the Socket.io handshake middleware (`server/socket/socketHandler.js:13-27`).
- The only authorization rule is "is authenticated". Any logged-in user can read and write the single global message stream.

### Frontend (`client/`)

- There are four routes (`client/src/App.jsx`):
  - `/`: the landing page.
  - `/login` and `/signup`: wrapped in `GuestRoute`.
  - `/chat`: wrapped in `ProtectedRoute`.

  Both guards check only whether a token exists.
- `client/src/pages/Chat.jsx` (457 lines) contains all chat state, the socket lifecycle, the history fetch, toasts, scroll handling, message grouping, and all chat markup.
- `client/src/socket.js` is a single shared socket instance created with `autoConnect: false`. It reads the token on each connection attempt. `Chat.jsx` connects the socket when it mounts and disconnects it when it unmounts.

### Client state management

- There is no state library.
- `client/src/context/AuthContext.jsx` holds the token and user, persisted in `localStorage` under the keys `relay_token` and `relay_user`.
- All chat state is local `useState` inside `Chat.jsx`.
- Axios (`client/src/api/axios.js`) and the socket both read `relay_token` directly from `localStorage`, not from the context.

### Deployment

- `README.md` describes the server on Render, the client on Vercel and the database on Neon.
- None of this is reflected in any configuration file in the repository (see §12).

---

## 3. Current Strengths

- Small, well-commented, consistently structured code that uses ES modules throughout.
- All SQL is parameterized, so there is no SQL injection surface.
- Sockets are authenticated at the handshake. Connections with invalid tokens are rejected before they are established.
- Login returns the same error whether the email is unknown or the password is wrong (`server/routes/auth.js:70-80`).
- REST and socket message payloads share the same camelCase shape (`server/routes/messages.js:24-30`, `server/socket/socketHandler.js:55-61`).
- The server saves each message before broadcasting it, so clients never see a message that was not stored.
- Typing indicators are debounced on the server and cleaned up when a user disconnects.
- The client socket reads the token on each connection attempt (`client/src/socket.js:14-17`), so logging out and back in works without recreating the socket.
- The chat view handles loading, error and empty states, and auto-scrolls only when the user is already near the bottom.
- The database connection falls back cleanly from `DATABASE_URL` to individual `DB_*` variables.

---

## 4. Confirmed Correctness Issues

1. **Server error messages are never shown to the user.**
   - The server returns `{ error }`, but the client reads `err.response?.data?.message` (`client/src/pages/Login.jsx:26`, `client/src/pages/Signup.jsx:26`).
   - A 409 duplicate-account response therefore shows "Signup failed", and a 500 during login shows "Invalid email or password".
2. **An unhandled pool error can crash the server.**
   - When an idle client fails, `pg-pool` emits `error` on the pool (`server/node_modules/pg-pool/index.js:62`).
   - No listener is registered (`server/db/connection.js`), and Node terminates the process on an unhandled `error` event.
   - *(inferred)* Hosted Postgres providers that drop idle connections, such as Neon, make this a realistic production crash path.
3. **Messages can be lost or duplicated during page load.**
   - The history fetch (`client/src/pages/Chat.jsx:90-101`) and the socket connection (`Chat.jsx:105`) start at the same time.
   - A message stored after the history query runs but before the socket connects is never shown.
   - A message that arrives through both paths is shown twice with a duplicate React key, because nothing removes duplicates by `id` (`Chat.jsx:108`).
4. **Messages missed while disconnected are not recovered.** Nothing re-fetches history after the socket reconnects.
5. **A failed send loses the user's text.**
   - The input is cleared as soon as the message is emitted (`Chat.jsx:157`), and the server sends no acknowledgement.
   - If the database insert fails, the user sees a toast but their text is gone. There is no client-side message ID for a retry.
6. **A signup race returns 500 instead of 409.** Signup checks for an existing user and then inserts (`server/routes/auth.js:19-35`). Two concurrent signups hit the unique constraint and fall through to the generic 500 handler.
7. **A username longer than 50 characters returns 500.** The server does not check length, so the insert fails on `VARCHAR(50)`.
8. **Toast IDs can collide.** They use `Date.now()` (`Chat.jsx:57`), so two toasts created in the same millisecond share a React key.
9. **The client fails lint.** `npm run lint` reports `react-refresh/only-export-components` at `client/src/context/AuthContext.jsx:41`.

---

## 5. Design Weaknesses

- **No server-side input limits.**
  - Message `content` has no maximum length on the server, and the client textarea has no `maxLength`.
  - Socket.io's default `maxHttpBufferSize` allows payloads of about 1 MB.
- **Every keystroke re-renders the whole message list.**
  - The composer's `text` state lives in the same component as the message list.
  - Message grouping is recomputed on every render (`Chat.jsx:187-194`), and `MessageBubble` is not memoized.
  - The `messages` array grows without bound.
- **Presence and typing are tracked per socket, not per user.**
  - `online_count` counts sockets in the current process (`socketHandler.js:34`), so one user with two tabs counts twice.
  - Typing state is keyed by user ID but tied to one socket, so closing one tab clears the indicator for another.
- **Expired sessions are handled inconsistently.**
  - `verifyToken` returns 401 for a missing token and 403 for an invalid or expired one (`server/middleware/verifyToken.js:8-20`).
  - Axios has no response interceptor, so an expired token produces "Could not load message history" instead of a logout.
  - Only the socket path logs the user out, and it detects the failure by searching the error message for "authentication" (`Chat.jsx:132`).
- **The server starts even when the database is unreachable.** Startup only logs the result of `SELECT NOW()` (`server/index.js:49-55`).
- **Required environment variables are not validated at startup.** A missing `JWT_SECRET` surfaces only when `jwt.sign` throws on the first login or signup.
- **Operational basics are missing.** There is no global Express error handler, no JSON 404 handler, no graceful shutdown and no request logging.

---

## 6. Technical Debt

- **The schema exists only in `README.md`.** There is no migration tool or migrations directory.
- **There are no tests.** `server` `npm test` is a placeholder that exits 1, the client has no test setup, and there is no CI.
- **The server has no lint configuration.**
- **Documentation is inaccurate.** `README.md`:
  - links a `LICENSE` file that does not exist;
  - says `cd relay-chat` after cloning `chat-app`;
  - tells readers to add `DATABASE_URL` support that `server/db/connection.js` already has.

  Separately, `server/db/connection.js:11` mentions Railway, while the README describes Render.
- **The fallback API ports disagree.** `client/src/api/axios.js:4` falls back to `:5000`, but `client/src/socket.js:5` and the server use `:5001`.
- **Leftover development comments:** `// ← NEW` markers in `server/index.js:12-13` and an "interviews" note in `client/src/api/axios.js:9`.
- **Unused Vite template files:**
  - `client/src/App.css` (184 lines, never imported)
  - `client/src/assets/hero.png`, `react.svg` and `vite.svg`
  - `client/public/icons.svg`
  - `client/README.md` (template boilerplate)
- **Duplicated logic:**
  - JWT signing is written out twice, in signup and login.
  - Token verification is implemented separately for HTTP and for sockets.
  - Mapping a database row to a message object is done separately for REST and for sockets.
  - The logo SVG and the form input styles are repeated across pages.
- **Hard-coded values:**
  - Hex colors are written inline throughout the JSX instead of in the Tailwind theme.
  - The landing page hard-codes "Version 1.0.0".

---

## 7. Security Findings

In rough priority order:

1. **There is no rate limiting anywhere.**
   - Login and signup are open to brute force and mass account creation.
   - `new_message` and `typing` are unthrottled, so one socket can flood every client.
2. **Message size has no server-side limit** (see §5).
3. **A long-lived bearer token is stored in `localStorage`.**
   - It is valid for 7 days and cannot be revoked (`client/src/context/AuthContext.jsx:8-16`), so any XSS would expose it.
   - React currently escapes message content. *(inferred)* Adding rich text, Markdown or link rendering would raise this risk.
4. **Registered emails can be discovered.**
   - Signup returns 409 "Email or username is already taken", which undoes the care taken to hide this in login.
   - Login also skips the bcrypt comparison when the email is not found, so response timing leaks the same information.
5. **Emails and usernames are case-sensitive.** `VARCHAR UNIQUE` allows `A@x.com` and `a@x.com` to be separate accounts, and allows lookalike usernames.
6. **Password rules are weak.**
   - The 6-character minimum is enforced only in the browser (`client/src/pages/Signup.jsx:99`).
   - There is no maximum length, and bcrypt silently ignores everything after 72 bytes.
7. **There are no security headers.** No helmet and no CSP. Fonts are loaded from Google Fonts, a third party (`client/index.html`).
8. **Open sockets are not re-checked.** A connected socket stays authorized after its token expires or the user logs out.
9. **Database TLS certificate verification is disabled** when `DATABASE_URL` is used (`ssl: { rejectUnauthorized: false }`, `server/db/connection.js:16`).
10. **`JWT_SECRET` is not checked** for presence or strength. The actual secret's strength was not examined.

`.env` is listed in `.gitignore` and has never been committed (checked with `git log --all`).

---

## 8. Architectural Constraints

These follow from verified code. Their consequences are *(inferred)*.

1. **One process holds all shared state.** Typing timers, the online count and `io.emit` all assume a single server instance. A second instance, including an overlapping instance during a deploy, would break presence and message delivery unless a shared Socket.io adapter is added.
2. **Client and server deploy separately without a versioned contract.** Socket event names and payloads are neither typed nor versioned, so browser tabs running an old bundle will talk to a newer server.
3. **The username is embedded in the JWT and copied into every message.** Messages are written with `socket.user.username` taken from the token (`server/socket/socketHandler.js:47`), and `messages.username` is a denormalized copy. Renaming a user would leave existing tokens and messages out of date.
4. **Timestamps are stored without a time zone.** `created_at` is `TIMESTAMP`, so its meaning depends on the database session's time zone.
5. **Sequential integer IDs are exposed to clients.** They are guessable, which matters once authorization depends on resource IDs.
6. **Tokens are checked only at the socket handshake**, and there is no mechanism to revoke a token.

---

## 9. Features That Fit the Current Architecture

These can be added without structural change:

- **Validation:** server-side checks on username, email and password length and format, and a maximum message length.
- **Fixes for issues in §4 and §5:**
  - the error-message field mismatch;
  - a pool `error` handler;
  - validation of required environment variables at startup;
  - a health check that also checks the database.
- **Indexing:** an index to support the history query's `ORDER BY created_at`.
- **Pagination:** cursor-based paging on `GET /api/messages?before=<id>`, for a "load older" button.
- **Catch-up after reconnecting:** `?after=<id>`, plus removing duplicate messages by `id` on the client.
- **Reliable sends:** a Socket.io acknowledgement on `new_message`, with a client-generated ID so failed sends can be retried and kept.
- **Session handling:** a `GET /api/auth/me` endpoint, and an Axios response interceptor that handles 401 and 403 the same way.
- **Splitting `Chat.jsx`:** into message list, composer and header components, plus a socket hook.
- **Cleanup:** removing dead template files and correcting `README.md`.
- **Hardening:** rate limiting and security headers. These probably require new dependencies.

---

## 10. Features Requiring Architectural Changes

| Feature | Required changes |
|---|---|
| **Multiple rooms, channels or DMs** | `conversations` and `memberships` tables, and `conversation_id` on `messages`. Socket.io rooms with membership checks when joining, sending and reading history. Room-scoped REST routes. Client routing (for example `/c/:id`) and client state organized per conversation. |
| **Per-room presence, typing, unread counts and read receipts** | Presence keyed by user and by room. Tables that record each user's read position. |
| **More than one server instance** | A shared Socket.io adapter (Redis or Postgres). Presence and typing moved out of process memory. |
| **Message editing, deletion, reactions and threads** | Schema changes (`edited_at`, `deleted_at`, `parent_id`, a reactions table), new events, and client-side reconciliation of updates. |
| **Attachments** | Object storage, signed uploads and a metadata table. |
| **Search** | Postgres full-text search or an external search engine. |
| **Notifications for offline users** | A background worker or job queue. |
| **Stronger authentication** (refresh tokens, httpOnly cookies, revocation, OAuth, email verification, password reset) | Session storage, CORS configured for credentialed cookies, and email delivery. |
| **Roles and moderation** | An authorization model. None exists today. |
| **Voice and video** | WebRTC signaling over sockets, TURN servers, and possibly a media server. |
| **Client state beyond one page** | *(inferred)* A structured state approach. Local `useState` in a single page does not scale to many conversations. |

---

## 11. Risks

All *(inferred)* from the findings above:

- **Regressions:** without tests, changes to the schema, events or authentication can be checked only by hand.
- **Schema drift and irreversible changes:** without migrations, adding columns such as `conversation_id` to a live database is a manual, one-way operation. Existing messages would need a default room.
- **Breaking open clients:** because the socket contract is implicit and the two sides deploy separately, changing payloads without a compatibility period will break tabs that are already open.
- **Risky refactors:** plain JavaScript without types makes broad renames, such as adding `conversationId` across the codebase, error-prone.
- **Rewriting the chat page:** `Chat.jsx` does everything, so multi-room work will largely rewrite it rather than extend it.
- **Forced logouts:** changing the JWT payload will log everyone out, unless both the old and new token shapes are accepted for a transition period.
- **Silent failures when scaling:** in-memory presence and typing state will misbehave without errors as soon as a second instance runs.

---

## 12. Unknowns

None of the following can be determined from the repository:

- **Production schema.** Whether the production database matches the schema in `README.md`, including indexes and column types, and how much data exists.
- **Production database connection.** Whether production uses `DATABASE_URL` (Neon) or the individual `DB_*` variables.
- **Database session time zone.** Which time zone the `TIMESTAMP` values are interpreted in.
- **Render.**
  - Which plan is used. *(inferred)* Free-tier instances sleep when idle, which would drop WebSocket connections.
  - The instance count.
  - The Node version.
  - Whether deploys overlap old and new instances.
- **Vercel.** Project settings, including whether a single-page-app rewrite is configured so that refreshing on `/chat` works. There is no `vercel.json` in the repository.
- **`JWT_SECRET` strength** in any environment.
- **Local `CLIENT_URL`.** The local `.env` does not set it, so the server uses its default of `http://localhost:5173`.

---

## 13. Questions Requiring Product/Architecture Decisions

**Product scope**

1. Which conversation types are needed: public channels, private invite-only groups, 1:1 DMs, or all of them? Is there a workspace or server level above them?
2. Which features belong in v1 and which later? Candidates: editing and deleting, reactions, threads, attachments, search, read receipts, unread counts, notifications, voice and video.
3. Are roles and moderation needed, such as owner, admin, mute, ban and report?
4. How long should messages be retained, and does deleting a message mean hiding it or erasing it?

**Scale and infrastructure**

5. What are the target numbers of concurrent users and messages per second? Are multiple server instances or zero-downtime deploys required?
6. Will Relay stay on Render, Vercel and Neon, and on which plans? Is adding Redis or object storage acceptable?
7. Must existing production data be preserved and migrated, for example into a default room, or can it be reset?

**Authentication**

8. Should authentication keep using bearer tokens in `localStorage`, or move to httpOnly cookies with refresh tokens? This affects CORS and deploying the client and server on different domains.
9. Are email verification, password reset, OAuth sign-in, or changeable usernames and profiles required?

**Engineering choices**

10. Should the codebase move to TypeScript? If so, should event and API types be shared between client and server through a workspace or shared package?
11. Which migration approach should be used: plain SQL files, node-pg-migrate, Knex, Drizzle or Prisma? Should queries remain hand-written SQL?
12. Which client state approach should be used: Context with a reducer, Zustand, or TanStack Query for server data?
13. What is the testing target: unit, API integration against a real Postgres, socket integration, end-to-end with Playwright? And should CI be added?
14. How many new dependencies are acceptable? Rate limiting, security headers, validation and logging each typically add one.
15. Is a mobile or native client planned? The answer decides how formally the REST and socket contract must be specified and versioned.
