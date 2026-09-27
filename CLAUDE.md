# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Relay: a single-room real-time group chat. Two independent npm projects, no root `package.json`:

- `server/` — Express 5 + Socket.io 4 + `pg` (PostgreSQL), ESM (`"type": "module"`). Existing code is JS; TypeScript is set up incrementally (`allowJs`, `checkJs: false`, `strict`) so new files can be `.ts`. Do not convert existing JS files.
- `client/` — React 19 + Vite + Tailwind v3 + React Router 7, JSX, with the same incremental TypeScript setup (`noEmit`; typecheck only)

Deployed as server on Render and client on Vercel (both deploy `main`), DB on Neon.

## Project status

Relay is being evolved into Relay V2 in phases (`docs/v2-design.md` §9; decisions D1–D17 in §10).

- **Phase 0 (foundation) is complete** (2026-09-27): see `docs/phase-0-implementation-plan.md`, §16 for the completion record and known issues.
- **Phase 1 (V2 data model on a fresh database, D6) is complete and in production** (2026-09-27). It was built on the `phase-1` branch and reached production by the cutover in `docs/phase-1-implementation-plan.md` §13: a new Neon database, a rotated `JWT_SECRET`, and PR #1 merged into `main`. See that plan's §15 for the completion record, the cutover and known issues, and `docs/adr/` for its decisions.
- **Phase 2 (sessions and security baseline) is in progress** on the long-lived `phase-2` branch (draft PR #2, "do not merge until the release"), following `docs/phase-2-implementation-plan.md` (approved 2026-09-28; decisions in its §16). M0 and M1 are done: sessions have replaced JWT on this branch. `main` is still Phase 1 in production and only gets Phase 2 through the plan's release runbook (§15). Production fixes go to `main` and are merged into `phase-2`.
- Working rules for every phase: one task per commit; a milestone starts only after the maintainer approves the previous one; don't implement items from a plan's deferred list; if a step needs something the plan doesn't list, stop and ask. Never connect to or modify the production database.

## Commands

```bash
# Local Postgres 17 (run from repo root) — creates relay_dev + relay_test on first start
docker compose up -d --wait
docker compose down -v      # wipe local data; next `up` recreates both databases

# Server (run from server/)
npm install
npm run migrate             # apply pending migrations to $DATABASE_URL (relay_dev)
npm run migrate:down        # roll back the last migration
npm run migrate:create -- <name>   # new SQL migration: migrations/NNNN_<name>.sql (underscores in <name> become hyphens)
DATABASE_URL=postgres://relay:relay@localhost:5433/relay_test?sslmode=disable npm run migrate   # migrate relay_test
npm run dev        # tsx watch index.js
npm run build      # tsc -p tsconfig.build.json → dist/
npm start          # node dist/index.js (run build first)
npm run typecheck  # tsc --noEmit
npm run lint       # eslint . (typescript-eslint recommended)

# Client (run from client/)
npm install
npm run dev        # Vite dev server on :5173
npm run build
npm run typecheck  # tsc --noEmit
npm run lint       # eslint .
npm run preview
```

## Tests (server)

```bash
# needs `docker compose up -d --wait`; run from server/
npm test                                   # vitest run: all integration tests against relay_test
npm run test:watch
npx vitest run test/socket.test.ts         # one file
npx vitest run -t "rejects a duplicate"    # tests whose name matches
```

- Integration tests only (Vitest + Supertest + socket.io-client) against real Postgres; no DB mocking. The client has no tests yet.
- `server/app.js` exports `createApp()` → `{ app, httpServer, io }` without listening; `index.js` only loads `.env`, checks the DB and listens. Tests start their own instance on port 0 via `test/helpers.ts`.
- **Database guard** (`test/testDatabase.ts`): tests use `DATABASE_URL`, or the local `relay_test` URL if it is unset. The run is refused unless the database name ends in `_test` and the host is local; `vitest.config.ts` checks this before anything runs, `test/setup.ts` re-checks the pool's actual connection string, and the per-test reset (`TRUNCATE` of all V2 tables `RESTART IDENTITY CASCADE`, then re-seeding `#general` with the migration's statement) refuses inside Postgres unless `current_database()` ends in `_test`. The root `.env`'s `DATABASE_URL` (relay_dev) is never used by tests.
- `globalSetup` applies migrations to the test database; `fileParallelism: false` because all files share one database.
- Tests have no cookie jar: `signUp(server)` returns the user and its session `cookie` (`name=value`, from `sessionCookieOf(res)`), which requests send with `.set('Cookie', cookie)` and `connectSocket(url, cookie)` sends in the handshake's headers. Session expiry is tested by moving `expires_at` / `last_seen_at` in the database, never by waiting.
- Socket tests wait for events (`nextEvent`) registered before the triggering emit — no sleeps/timeouts.
- `test/schema.test.ts` tests every `0002` and `0003` constraint directly in the database, with a factory per table. `test/sessions.test.ts` covers the session cookie, `/me`, expiry, the idle timeout and logout. `test/ordering.test.ts` proves the send transaction's guarantees (concurrent sends are gapless, a failed send takes no `seq`).

## Environment

- Server env lives in a `.env` at the **repo root**, not in `server/`. `server/config/env.ts` is the **only** module that loads it and reads `process.env`: it resolves the path relative to its own location (with an extra `..` when running from the compiled `server/dist/`), validates everything with zod, and exports a frozen `config` (`config.nodeEnv`, `config.port`, `config.clientUrl`, `config.database`, …). Other code imports `config` — never read `process.env` directly. Invalid/missing variables make the server print their names (never values) and exit 1 before listening.
- Because `config/env.ts` is TypeScript, the server must run via `tsx` (`npm run dev`) or the compiled build (`npm start`); plain `node index.js` no longer works.
- Server vars: `DATABASE_URL` (takes precedence and enables SSL) or the legacy `DB_USER`, `DB_HOST`, `DB_NAME`, `DB_PASSWORD`, `DB_PORT` (migrations only read `DATABASE_URL`), plus `PORT` (default 5001), `CLIENT_URL` (default `http://localhost:5173`, used for both Express and Socket.io CORS) and `NODE_ENV` (`production` on Render makes the session cookie `__Host-relay_session` with `Secure`; leave it unset locally). There is no `JWT_SECRET` any more.
- Client: `client/.env.local` with `VITE_API_URL=http://localhost:5001`. If it is unset, both `client/src/socket.js` and `client/src/api/axios.js` fall back to `http://localhost:5001`.
- Local dev uses `DATABASE_URL=postgres://relay:relay@localhost:5433/relay_dev?sslmode=disable` (see `.env.example`). `sslmode=disable` is required: `connection.js` forces SSL whenever `DATABASE_URL` is set, and the URL's `sslmode` overrides it. Docker publishes Postgres on host port **5433** (not 5432) to avoid clashing with a local Postgres install. Never point the running app at `relay_test`; it is reserved for tests.
- Schema is managed by node-pg-migrate SQL migrations in `server/migrations/` (`-- Up Migration` / `-- Down Migration` sections; applied names tracked in the `pgmigrations` table). `0001_initial` is the Phase 0 schema. `0002_v2_schema` drops it and creates the V2 schema (`docs/v2-design.md` §4) with named constraints: `users` (lowercase `username`, `email`; `display_name`; `password_hash`), `conversations` (channels and DMs; the per-conversation `last_seq` counter), `direct_conversations`, `conversation_members` (`role`, `last_read_seq`) and `messages` (`seq`, `author_id`, `client_id`). It seeds the public `#general` channel; its down migration restores the Phase 0 tables. `0003_sessions` adds `sessions` (`token_hash` = SHA-256 of the cookie token, `user_id` ON DELETE CASCADE, `last_seen_at`, `expires_at`, `user_agent`). Limits shared by code and tests live in `server/lib/limits.ts`; migrations repeat the ones the database enforces, and `test/schema.test.ts` checks that both agree.

## Architecture

**Auth is server-side sessions in an httpOnly cookie** (`docs/v2-design.md` §6, D3). Signup and login (`server/routes/auth.js`) each create a new session (a cookie the request already carries is never reused): a random 32-byte token goes only into the cookie, and `sessions` stores its SHA-256. Signup creates it in the same transaction as the user and the `#general` membership. `server/lib/sessions.ts` owns the token, the hash and the cookie (`sessionCookie.set/clear/read`): `relay_session`, `HttpOnly`, `SameSite=Lax`, `Path=/`, `Max-Age` 30 days, and in production `__Host-relay_session` with `Secure`. A session is valid until `expires_at` (30 days) and while `last_seen_at` is within 7 days; `findSessionUser` (`server/repositories/sessions.ts`) checks both and moves `last_seen_at` at most once an hour, in one statement. The limits are in `lib/limits.ts`. The session is checked in two places, which must stay in step: `server/http/requireSession.ts` for HTTP (sets `req.user` = `{ id, username, email }` and `req.session`; every failure is 401 `UNAUTHENTICATED` "Your session has expired. Please log in again.") and the `io.use` middleware in `server/socket/socketHandler.js` for the socket handshake, which reads the cookie from `socket.handshake.headers.cookie` and sets `socket.user` (`{ id, username }`) and `socket.sessionHash`. Its rejections say "Authentication error: …", which the client treats as a logout, so a failed lookup says "Server error" instead (and a failed HTTP lookup is a 500). `GET /api/auth/me` returns the user; `POST /api/auth/logout` deletes this session only, clears the cookie and always answers 204. The token must never reach a response body, the logs or the database.

**Client auth state** lives in `client/src/context/AuthProvider.jsx`: `{ status: 'loading' | 'authenticated' | 'guest', user, login(user), logout() }`. JavaScript cannot read the cookie, so on start it asks `GET /api/auth/me`, and `ProtectedRoute` / `GuestRoute` render nothing while `loading`. `login(user)` takes the user from the signup or login response; `logout()` calls `POST /api/auth/logout`, then becomes `guest`, and the routes redirect. A response interceptor it registers on the Axios instance turns any 401 `UNAUTHENTICATED` into a local logout (a wrong password, 401 `INVALID_CREDENTIALS`, is left to the form). Axios and the Socket.io client send the cookie with `withCredentials: true`; nothing auth-related is in `localStorage` (the provider deletes the old `relay_token` / `relay_user` keys).

**Data access:** SQL lives in `server/repositories/` (TypeScript: `users`, `conversations`, `messages`, `sessions`). Each function takes a `Queryable`: the pool, or the client inside `withTransaction(fn)` (`server/db/transaction.ts`: BEGIN, COMMIT, or ROLLBACK and rethrow). Emit socket events only after the transaction has committed. There is no service layer yet (Phase 3). Request bodies are validated with zod schemas in `server/http/schemas.ts`: `schema.safeParse(req.body)`, then `next(validationError(result.error))` on failure (400 `VALIDATION_ERROR`, `details` = `[{ field, message }]`). Signup normalizes usernames and emails to lowercase and stores the typed username as `display_name`.

**Message flow:** the single-room app reads and writes `#general`, looked up by name (never a hard-coded id); signup adds every new user as a member. History is fetched once over REST (`GET /api/messages`: `#general`'s last 50 by `seq`, returned oldest→newest); live messages arrive over the socket. The client emits `new_message { content }`: the server ignores anything without non-blank text and rejects over 4000 characters (`MESSAGE_MAX_LENGTH`, counted in code points) with `error`. Then, in one transaction, it takes the next `seq` (`UPDATE conversations SET last_seq = last_seq + 1 … RETURNING`, which locks the row, so seqs are gapless and in commit order), inserts the message with a server-generated `client_id` only if the sender is a member (`INSERT … SELECT … WHERE EXISTS`; otherwise it rolls back, which returns the seq, and emits `error`), and moves the sender's `last_read_seq` forward (`GREATEST`). After COMMIT it `io.emit`s `message` to **all** clients including the sender (no optimistic UI — the sender renders its own message from the broadcast). REST and socket payloads both use the camelCase shape `{ id, seq, userId, username, content, createdAt }`, built for both by `server/repositories/messages.ts`.

**REST errors** always use the envelope `{ error: { code, message, details? } }`. Routes and middleware never write error JSON themselves: they call `next(new AppError(status, ErrorCode.X, message))` (`server/lib/errors.ts`; use `next`, not `throw`, inside a route's `try` so its `catch` doesn't turn it into a 500). `app.js` mounts `http/notFound.ts` on `/api` after all routes (JSON 404) and `http/errorHandler.ts` last (AppError → its status; bad JSON → 400 `INVALID_JSON`; other body errors keep their 4xx; anything else → logged + generic 500, never a stack). Add new codes to `ErrorCode` only when a response needs one. The client reads messages with `getErrorMessage(err, fallback)` from `client/src/lib/errors.ts`. Socket errors are separate and unchanged (`connect_error` / `error { message }`).

**Logging:** never use `console.*` in server code — import `logger` from `server/lib/logger.ts` (pino, JSON lines on stdout, level from `LOG_LEVEL`, default `info`). Log errors as `logger.error({ err }, 'message')` so the stack is kept, and put context in fields rather than in the message string. `app.js` mounts `pino-http` first, so every Express request gets one `request completed` line (Socket.io traffic bypasses it); socket handlers use a per-connection child logger. Redaction (`loggerOptions.redact`) hides `req.headers.authorization`, `req.headers.cookie` and `res.headers["set-cookie"]` (both carry the session token), any `password` up to two levels deep, and Postgres `err.detail` (it can contain row values); never log request bodies or tokens. Tests run with `LOG_LEVEL=silent`; `test/logger.test.ts` checks the redaction. The only log line written without `logger` is the config-failure line in `config/env.ts` (a default pino instance, because the logger's level comes from that config).

**Lifecycle:** `db/connection.js` registers `pool.on('error')`: an idle connection dropped by the database is logged and the pool reconnects — without that listener Node would crash (pg-pool emits `error` on the pool). On SIGTERM/SIGINT, `index.js` shuts down gracefully: `await io.close()` (disconnects sockets, which then auto-reconnect to the next instance; closes the HTTP server and waits for in-flight requests), then `await pool.end()`, then exit 0. A 10 s unref'd timer forces exit 1 if that hangs, and repeated signals during shutdown are ignored (Ctrl-C delivers SIGINT from both the terminal and `tsx watch`). Keep anything that holds resources (timers, connections) closable by this sequence.

**Socket events:**
- client → server: `new_message { content }`, `typing`
- server → client: `message`, `online_count` (from `io.sockets.sockets.size`), `user_typing` / `user_stop_typing` (username string), `error { message }`

Typing is debounced server-side: a per-user timer map broadcasts `user_typing` once per burst and `user_stop_typing` after 3s of silence or on disconnect.

**Socket lifecycle:** `client/src/socket.js` is a singleton with `autoConnect: false`. `client/src/pages/Chat.jsx` calls `socket.connect()` on mount, registers listeners, and `off`s them + disconnects on unmount; a `connect_error` whose message contains "authentication" (an expired or revoked session) logs the user out. Add new listeners inside that same effect and remove them in its cleanup.

**Routing** (`client/src/App.jsx`): `/` Landing, `/login` and `/signup` wrapped in `GuestRoute` (redirects authed users to `/chat`), `/chat` wrapped in `ProtectedRoute` (redirects to `/login`). These routes exist only in the client (`BrowserRouter`): on Vercel, `client/vercel.json` rewrites every path that is not a file to `index.html`, without which reloading `/chat` is a 404. Vite's dev server does this by itself, so local runs never show it.
