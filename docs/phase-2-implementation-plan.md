# Relay — Phase 2 Implementation Plan

**Status:** 🚧 **Approved, in progress** on the `phase-2` branch (draft PR #2). M0 is done (2026-09-28).
**History:** approved 2026-09-28; the maintainer's decisions on the open questions are recorded in [§16](#16-decisions-confirmed-at-approval).
**Scope source:** `docs/v2-design.md` (§6 security model, §8 deployment, §9 Phase 2; decisions D3, D4, D15, D17), the deferred list in `docs/phase-0-implementation-plan.md` §15, and the handoff in `docs/phase-1-implementation-plan.md` §16.
**Rule:** if a step seems to need something not listed here, stop and ask. Do not expand the scope.

---

## 1. Goal

Replace the 7-day JWT in `localStorage` with revocable server-side sessions, and add the security baseline around them:

- signup and login create a session: an opaque token in an httpOnly cookie, stored only as a hash in Postgres; `GET /api/auth/me` and `POST /api/auth/logout` complete the API;
- logout disconnects that session's sockets at once, and a periodic sweep disconnects sockets whose session has expired or been revoked (audit §7.8);
- CSRF defenses in three layers: `SameSite=Lax`, an `Origin` check on state-changing requests and on the socket handshake, and JSON-only request bodies;
- password rules and the login timing fix (audit §7.4, §7.6); rate limits on login and signup (the auth part of audit §7.1); helmet; `trust proxy`; database TLS verification pinned explicitly (audit §7.9);
- a production cookie topology: the SPA served by Express (§16, decision 1), so that Phase 2 can go to production at the end of the phase.

**Done when** (design §9): no token is readable by JavaScript, and logout cuts off live sockets.

Phase 2 adds no conversation features, rooms other than session rooms, or message rate limits (§14).

---

## 2. Decisions this plan implements

| # | Decision | How this plan applies it |
|---|---|---|
| 1 | **Server-side sessions** (D3), with the defaults in design §6 | A `sessions` table (migration `0003`), a random token in an httpOnly cookie, SHA-256 hash stored, 30-day absolute and 7-day idle expiry, a new session on every login. JWT and `JWT_SECRET` are removed entirely (M1). |
| 2 | **Production cookie topology** (the D4 open item) | **Serve the SPA from Express** (option A, chosen at approval, §16). M0–M4 do not depend on it, because local development is same-site already. M5 implements it. |
| 3 | **Production stays on Phase 1 until Phase 2 is complete**, as in Phase 1 | Render and Vercel deploy `main`, so Phase 2 is built on a long-lived `phase-2` branch with a draft PR and reaches production through the release runbook (§15). |
| 4 | **Minimal dependencies** (D17) | Added: `helmet` and `express-rate-limit` (both planned for Phase 2 in D17), and `cookie` as a direct dependency for parsing the cookie in both Express and the socket handshake. It is `cookie` 2.x, not the 0.7.2 that express and engine.io bring: 0.7.2 has no TypeScript types, while 2.x ships its own and is ESM like the server (M1). Removed: `jsonwebtoken`. Nothing else. |
| 5 | **Expand, then contract** (design §7) | `0003` only adds a table, so it can be applied to production before the release while Phase 1 is still running. The code stops using JWT in the same release, and the `JWT_SECRET` variable is deleted from Render after it. |

---

## 3. Starting state (verified 2026-09-27)

- `main` at `a2d2dde`; CI green; 124 server tests. Production runs Phase 1 since the cutover on 2026-09-27, on a new Neon database over its direct (unpooled) connection. The old database is deleted.
- **Auth today:** a JWT `{ id, username }`, valid 7 days and signed with `JWT_SECRET`, is returned in the signup and login bodies. The client keeps it in `localStorage` (`relay_token`, `relay_user`) and sends it as `Authorization: Bearer` (Axios interceptor) and in the socket handshake's `auth` (`client/src/socket.js`). It is verified in `server/middleware/verifyToken.js` (401 without a token, 403 `INVALID_TOKEN` when invalid) and in the `io.use` middleware of `server/socket/socketHandler.js`.
- **CORS:** Express and Socket.io allow `CLIENT_URL` with credentials. There is no `Origin` check, no rate limiting and no helmet; responses carry `X-Powered-By: Express`.
- **Logging:** pino-http logs response headers (`res.headers`), so a `Set-Cookie` carrying the session token would be written to the logs unless it is redacted. `req.headers.cookie` is already redacted.
- **Database TLS:** `db/connection.js` passes `ssl: { rejectUnauthorized: false }`, but the parsed `DATABASE_URL` overrides it. With pg-connection-string 2.13, `sslmode=require` becomes `ssl = {}`, which verifies the certificate, so production most likely verifies already (to confirm: Render's `DATABASE_URL` has `sslmode=require`, as Neon's connection strings do). pg also warns that a future release will treat `require` like libpq does, without verification. The fix is therefore to pin `sslmode=verify-full`, not to switch verification on.
- **Client routing on Vercel:** `client/vercel.json` rewrites client routes to `index.html`.
- **Code that changes:** `server/routes/auth.js`, `middleware/verifyToken.js` (removed), `socket/socketHandler.js`, `config/env.ts`, `db/connection.js`, `app.js`, `index.js`, `lib/logger.ts`, `lib/errors.ts`, `lib/limits.ts`; `client/src/context/AuthProvider.jsx`, `api/axios.js`, `socket.js`, `components/ProtectedRoute.jsx`, `components/GuestRoute.jsx`, `pages/Login.jsx`, `pages/Signup.jsx`, `pages/Chat.jsx`; tests `helpers.ts`, `auth`, `errors`, `env`, `logger`, `messages`, `socket`, `ordering`.

---

## 4. Workflow and safety rules

- [ ] **All Phase 2 commits go to the long-lived `phase-2` branch, never to `main`.** A draft pull request `phase-2 → main` ("do not merge until the release") runs CI on every push. Phase 2 reaches production only through the release runbook (§15).
- [ ] One task per commit, with lint, typecheck, tests and build before each commit. A milestone is done when CI is green on the branch and its verification and definition of done are met; the next milestone starts only after the maintainer approves.
- [ ] Production fixes go to `main`, and `main` is merged into `phase-2` afterwards.
- [ ] Never connect to or modify the production database. `0003` runs against `relay_dev`, `relay_test`, CI's database and scratch databases; production gets it only in the release runbook, run by the maintainer.
- [ ] Tests only run against a local `*_test` database, and never sleep: the session sweep is a function tests call directly, and expiry is tested by setting `expires_at` or `last_seen_at` in the database.
- [ ] Session tokens never appear in logs, response bodies or the database: only in the `Set-Cookie` and `Cookie` headers (both redacted from logs); the database stores their SHA-256.
- [ ] Limits shared by code and tests (password length, session lifetimes, rate limits, sweep interval) live in `server/lib/limits.ts`.

---

## 5. Milestones

Each milestone ends with the app working locally and CI green on `phase-2`. They are done strictly in order.

| Milestone | Delivers | Depends on |
|---|---|---|
| **M0 — Branch and baseline** | `phase-2` branch, draft PR, green CI, Vercel previews of the branch off | — |
| **M1 — Sessions replace JWT** | Migration `0003`, the session cookie, `/me`, logout, the client on cookies, JWT removed | M0 |
| **M2 — Session lifecycle on sockets** | Session rooms, logout disconnects the session's sockets, the periodic sweep | M1 |
| **M3 — CSRF, Origin checks and helmet** | `Origin` checks on state-changing requests and the socket handshake, JSON-only bodies, helmet | M2 |
| **M4 — Passwords and rate limits** | Password rules, the login timing fix, login and signup limits, `trust proxy` | M3 |
| **M5 — Production topology and database TLS** | The chosen topology, `sslmode=verify-full` enforced, the release runbook ready | M4 |
| **M6 — Verification and handoff** | Fresh-clone verification, ADRs, docs, completion record | M5 |

Why this order: M1 is the one unavoidable big step. Once the server stops returning a token, the client must switch at the same time, so both change together. M2–M4 are independent hardening steps on a working cookie-based app. M5 comes last because it changes how production is deployed and has to carry everything before it to production.

---

## 6. Milestone 0 — Branch and baseline

**Objective:** a place to build Phase 2 where CI runs on every push and nothing reaches production.

**Steps**
1. Commit this plan (once approved) to `main`.
2. Create `phase-2` from `main`. Its first commit disables Vercel deployments of the branch (§16, decision 3): `"git": { "deploymentEnabled": { "phase-2": false } }` in `client/vercel.json`. That commit also gives GitHub the change it needs before it will open a pull request (in Phase 1 an empty commit was needed).
3. Push `phase-2` and open a draft pull request `phase-2 → main` titled "Phase 2: sessions and security baseline — do not merge until the release".

**Verification**
- CI runs on the draft PR and is green.
- GitHub shows no Vercel deployment for `phase-2`, and the maintainer confirms that Render deployed nothing.

**Definition of done**
- [x] `phase-2` exists with a draft PR and green CI. *(PR #2; the first commit, `f3d603f`, passed CI.)*
- [x] Pushes to `phase-2` deploy nothing. *(Vercel created no deployment for the branch; the maintainer confirmed that Render builds only `main`.)*

---

## 7. Milestone 1 — Sessions replace JWT

**Objective:** signup and login create a server-side session in an httpOnly cookie; every REST route and the socket handshake authenticate by that cookie; the client never sees a token; JWT is gone.

**Session rules** (design §6; values in `lib/limits.ts`)
- **Token:** 32 random bytes (`crypto.randomBytes`), base64url-encoded in the cookie. The database stores its SHA-256 (`bytea`, 32 bytes). The token itself is never stored or logged.
- **Cookie:** in production `__Host-relay_session; HttpOnly; Secure; SameSite=Lax; Path=/`. In development and tests `relay_session; HttpOnly; SameSite=Lax; Path=/`, without `Secure`: browsers differ on `Secure` cookies over `http://localhost`, and the `__Host-` prefix requires `Secure`. The choice follows `NODE_ENV === 'production'`. `Max-Age` is the absolute limit.
- **Lifetime:** a 30-day absolute limit (`expires_at`, set at creation) and a 7-day idle timeout (valid only while `last_seen_at` is within 7 days). `last_seen_at` is updated at most once an hour per session, in the same query as the lookup.
- **One session per login:** every signup and login creates a new session and sets a new cookie. An existing cookie is never reused, so a planted cookie cannot become a logged-in session (no session fixation).
- **`user_agent`:** stored, cut to 512 characters, for the session list planned later (D11).

**Migration `0003_sessions`** (additive; created with `npm run migrate:create -- sessions`)
- `sessions`: `token_hash bytea PRIMARY KEY` with CHECK `octet_length(token_hash) = 32`; `user_id integer NOT NULL` → `users` ON DELETE CASCADE; `created_at`, `last_seen_at timestamptz NOT NULL DEFAULT now()`; `expires_at timestamptz NOT NULL`; `user_agent text` with CHECK length ≤ 512. Indexes on `user_id` and `expires_at` (design §4).
- Down: `DROP TABLE sessions`.

**Server**
- `server/repositories/sessions.ts`: create, find valid (with the throttled `last_seen_at` update), delete one.
- `POST /api/auth/signup` and `POST /api/auth/login`: unchanged validation and errors; they respond with `Set-Cookie` and `{ user }`, without `token`. Signup creates the session in the same transaction as the user and the `#general` membership.
- `GET /api/auth/me`: `200 { user: { id, username, email } }`, or 401.
- `POST /api/auth/logout`: deletes the session, clears the cookie, 204. Without a valid session it still clears the cookie and returns 204, so logout never fails.
- `requireSession` middleware (replaces `verifyToken.js`) sets `req.user` and `req.session`. A missing, unknown, expired or idle session gives 401 `UNAUTHENTICATED` with "Your session has expired. Please log in again." for every case. `INVALID_TOKEN` (403) is removed from `ErrorCode`.
- Socket handshake: reads the cookie from `socket.handshake.headers.cookie` and looks the session up. It sets `socket.user` (`{ id, username }`) and `socket.sessionHash`, and rejects with the existing "Authentication error: …" messages, which the client relies on.
- JWT removed: the `jsonwebtoken` dependency, `JWT_SECRET` in `config/env.ts`, `.env.example` and the tests, and `middleware/verifyToken.js`.
- Logging: `res.headers["set-cookie"]` is added to the redacted paths.

**Client**
- `AuthProvider`: calls `GET /api/auth/me` on start and holds `{ user, status: 'loading' | 'authenticated' | 'guest' }`. `login(user)` stores the user returned by signup or login; `logout()` calls `POST /api/auth/logout` and then clears it. On start it also removes the legacy `relay_token` and `relay_user` keys from `localStorage`.
- `ProtectedRoute` and `GuestRoute` render nothing while the status is `loading`, instead of redirecting too early.
- Axios: `withCredentials: true`. A response interceptor turns a 401 with code `UNAUTHENTICATED` into a local logout, so the routes redirect to `/login`. A failed login (401 `INVALID_CREDENTIALS`) is not affected.
- `socket.js`: `withCredentials: true` and no `auth` callback. `Chat.jsx` keeps logging out on an authentication `connect_error`.

**Files likely to change:** `server/migrations/0003_sessions.sql` (new), `server/repositories/sessions.ts` (new), `server/http/requireSession.ts` (new), `server/lib/sessions.ts` (new: token, hash, cookie options), `server/routes/auth.js`, `server/routes/messages.js`, `server/socket/socketHandler.js`, `server/app.js`, `server/config/env.ts`, `server/lib/errors.ts`, `server/lib/limits.ts`, `server/lib/logger.ts`, `server/package.json`, `.env.example`, the client files listed in §3, and the tests.

**Tests**
- Signup and login set the cookie (`HttpOnly`, `SameSite=Lax`, `Path=/`, 30-day `Max-Age`) and return no token. The database holds the SHA-256 of the cookie value, never the value.
- With `NODE_ENV=production`, the cookie is `__Host-relay_session` with `Secure`.
- `/me` works with the cookie. It returns 401 without a cookie, with an unknown token, after `expires_at`, and when `last_seen_at` is 8 days old. `last_seen_at` moves when it is more than an hour old, and not on every request.
- Every login creates a new session; two sessions of one user work independently.
- Logout deletes only its own session and clears the cookie; `/me` then returns 401. Logout without a session returns 204.
- Deleting a user ends their sessions (cascade).
- `GET /api/messages` requires a session.
- The socket connects with a valid session cookie and is rejected without one, or with an unknown or expired session.
- `Set-Cookie` is redacted in the logs (`logger.test.ts`).
- Existing tests move from tokens to cookies: `signUp()` returns the cookie, and `connectSocket()` sends it in `extraHeaders`.

**Verification**
- Manually, in the browser: signup, a reload keeps you logged in (via `/me`), logout, login again. `localStorage` holds no `relay_*` keys, and `document.cookie` does not show the session cookie.

**Definition of done**
- [ ] No token is readable by JavaScript: nothing in `localStorage` or any response body, and the cookie is `HttpOnly`.
- [ ] No JWT code, dependency or configuration remains.

---

## 8. Milestone 2 — Session lifecycle on sockets

**Objective:** a session that ends takes its sockets with it, whether it ends by logout, expiry or deletion.

**Steps**
1. **Session rooms:** each socket joins `session:<token hash, hex>` when it connects.
2. **Logout disconnects:** after deleting the row, logout calls `io.in('session:<hash>').disconnectSockets(true)`. Only that session's sockets are cut; the same user's other sessions stay connected. The auth router receives `io` from `createApp`.
3. **The sweep:** `sweepSessions(io)` runs every 5 minutes on an unref'd interval started by `createApp`. It is stopped by the shutdown sequence before `pool.end()`, and by the test helper's `close()`. Each run:
   - checks the session hashes of all connected sockets in one query, which returns those still valid and bumps their `last_seen_at`. An open socket counts as activity, so someone who only chats over the socket is not idled out;
   - disconnects the sockets of the others (audit §7.8);
   - deletes expired and idle session rows.

**Tests**
- Logout disconnects the sockets of that session (the client sees `disconnect` with reason `io server disconnect`), but not a socket of the same user's other session.
- The sweep disconnects a socket whose session was deleted or has expired, keeps valid ones, bumps their `last_seen_at`, and deletes expired rows.
- Shutdown stops the sweep: after `close()`, no timer keeps the process alive.

**Definition of done**
- [ ] Logout cuts off the live sockets of that session.
- [ ] Sockets of expired or revoked sessions are disconnected by the sweep.

---

## 9. Milestone 3 — CSRF, Origin checks and helmet

**Objective:** a page on another site cannot act as the user, over HTTP or over the socket.

**Steps**
1. **`Origin` check** on every `POST`, `PUT`, `PATCH` and `DELETE` under `/api`: the `Origin` header must be an allowed origin (`CLIENT_URL`). Otherwise the answer is 403 `FORBIDDEN` "Request origin is not allowed." A missing `Origin` is rejected too, because browsers always send it on these methods.
2. **JSON-only bodies:** the same requests need `Content-Type: application/json`; anything else gets 415 `UNSUPPORTED_MEDIA_TYPE` "Request body must be JSON.". This forces a CORS preflight that a foreign site cannot pass. The client's logout sends `{}`. The M1-era test for a non-JSON body (400) changes to 415.
3. **Socket handshake `Origin` check**, through Socket.io's `allowRequest`: a handshake from an origin that is not allowed is refused. CORS does not protect WebSockets.
4. **helmet** on Express with its defaults, except the Content Security Policy, which belongs to the SPA and comes in Phase 8. This removes `X-Powered-By`.

**Tests**
- A `POST` with a wrong or missing `Origin` gets 403; with the allowed `Origin` and a form content type, 415. A `GET` without `Origin` still works.
- A socket handshake with a wrong or missing `Origin` is rejected.
- helmet headers are present (`X-Content-Type-Options: nosniff`), and `X-Powered-By` is gone.
- The test helpers send the allowed `Origin` and JSON by default.

**Definition of done**
- [ ] Every state-changing request and every socket handshake is checked against the allowed origin.

---

## 10. Milestone 4 — Passwords and rate limits

**Objective:** brute force and weak passwords are limited, and login timing no longer reveals which emails exist (audit §7.1 auth part, §7.4, §7.6).

**Passwords** (signup only; §16, decision 4)
- At least 8 characters and at most 72 bytes in UTF-8 (bcrypt's limit), rejected with 400 `VALIDATION_ERROR`, never silently truncated. Login still accepts any non-empty password, so existing accounts keep working.
- Signup form: `minLength` 8 and the placeholder "At least 8 characters". The byte limit is left to the server.

**Timing fix**
- For an unknown email, login still runs `bcrypt.compare` against a fixed dummy hash of the same cost before answering the same 401.

**Rate limits** (`express-rate-limit`, in-memory store; acceptable on one instance, D15/D16)
- Login: 10 **failed** attempts per 15 minutes per IP and normalized email. Successful logins do not count.
- Signup: 20 per hour per IP (§16, decision 5).
- Over the limit: 429 `RATE_LIMITED` "Too many attempts. Please try again later." in the error envelope, with `Retry-After`.
- The limits come from `lib/limits.ts` and are an option of `createApp`, so each test server has fresh counters and a test can set low limits.

**`trust proxy`**
- `TRUST_PROXY` (the number of proxy hops; default 0, trust nothing) configures Express. The release sets it to Render's real depth and verifies it (§15, step 6). Request log lines include `req.ip`, so the value can be checked; the rate limits key on it.

**Tests**
- Passwords of 8 characters and of exactly 72 bytes are accepted; 7 characters and 73 bytes (multi-byte characters) are rejected.
- Login for an unknown email calls `bcrypt.compare` (spy) and answers the usual 401.
- The 11th failed login for one IP and email gets 429 with `Retry-After`, while another email and a correct password still get through. The 21st signup from one IP gets 429.
- With `TRUST_PROXY=0`, a spoofed `X-Forwarded-For` does not change the rate-limit key. With `TRUST_PROXY=1`, the client IP comes from the header.

**Definition of done**
- [ ] Password rules, the timing fix and the login and signup limits are in place and tested.

---

## 11. Milestone 5 — Production topology and database TLS

**Objective:** everything Phase 2 needs to run in production is ready, and the release runbook (§15) is reviewed.

**Database TLS**
- `db/connection.js` drops the ignored `ssl: { rejectUnauthorized: false }`; TLS settings come from `DATABASE_URL`.
- Config validation: a `DATABASE_URL` whose host is not local must say `sslmode=verify-full`, or the server refuses to start and names the variable (values are never shown). Local hosts keep `sslmode=disable`.
- The release changes Render's `DATABASE_URL` from `sslmode=require` to `sslmode=verify-full`, keeping `channel_binding=require`.
- Tests: the new configuration rule (`env.test.ts`).

**Topology: serve the SPA from Express** (option A, chosen at approval, §16)
- Express serves `client/dist`: hashed `/assets/*` with a long cache, `index.html` with `no-cache`, and `index.html` for any other `GET` outside `/api` and `/socket.io` (this replaces the Vercel rewrite).
- The client uses relative URLs when `VITE_API_URL` is unset (Axios `baseURL` empty, `io()` without a URL). `vite.config` proxies `/api` and `/socket.io` (with WebSockets) to `localhost:5001`, so development has the same single origin as production.
- With one origin everywhere, the `cors` middleware and Socket.io's `cors` option are removed. The allowed origin (M3) is the app's public URL, still read from `CLIENT_URL`.
- Render builds both projects (settings in §15). The Vercel project becomes a redirect to the Render URL (a `redirects` rule in `client/vercel.json`) or is removed. The README's demo link changes.
- Tests, against a small fixture directory so that the server tests need no client build: `/chat` returns `index.html`, `/api/unknown` still returns the JSON 404, and an asset is served with its cache header.

**Verification**
- The production build runs locally with `NODE_ENV=production`, the client served by Express. In headless Chrome, login sets `__Host-relay_session` (Chrome treats `localhost` as a secure context), a reload keeps you logged in, and the socket connects.

**Definition of done**
- [ ] The chosen topology works locally in production mode.
- [ ] `sslmode=verify-full` is enforced for non-local databases.
- [ ] The release runbook (§15) is reviewed and ready.

---

## 12. Milestone 6 — Verification and handoff

**Steps**
1. **ADRs:** `docs/adr/0004-server-side-sessions.md` (D3: sessions instead of JWT, the cookie, the three CSRF layers) and `docs/adr/0005-production-cookie-topology.md` (the D4 choice from §16, decision 1).
2. **Docs:** CLAUDE.md (the auth architecture, environment variables, topology, test helpers), README (auth, deployment, environment variables), `docs/v2-design.md` §9 (Phase 2 status), this plan.
3. **Fresh-clone verification:** follow the README from a fresh clone of `phase-2` and a clean Docker volume, as in Phases 0 and 1.
4. **Completion record** in this plan, and the release runbook (§15) reviewed.

**Definition of done**
- [ ] Every item in §13 is checked.
- [ ] The maintainer decides when to run the release (§15).

---

## 13. Final Phase 2 verification checklist

- [ ] `phase-2` CI is green: lint, typecheck, tests and build for both projects.
- [ ] A fresh clone and clean Docker volume build `relay_dev` and `relay_test` from `0001`–`0003`; `0003` rolls back and re-applies cleanly.
- [ ] No token is readable by JavaScript: none in `localStorage` or response bodies, and the cookie is `HttpOnly` (`Secure` and `__Host-` in production mode).
- [ ] Logout disconnects that session's sockets; the sweep disconnects expired and revoked sessions.
- [ ] Cross-origin state-changing requests and socket handshakes are rejected; bodies must be JSON.
- [ ] Password rules, the login timing fix and the login and signup rate limits are tested.
- [ ] No session token appears in logs; `Set-Cookie` and `Cookie` are redacted.
- [ ] No JWT code, dependency or configuration remains.
- [ ] The chosen topology works locally in production mode, and `sslmode=verify-full` is enforced.
- [ ] Production is still on Phase 1 until the release: nothing from `phase-2` merged to `main`, and the production database untouched.
- [ ] Nothing from §14 was implemented.

---

## 14. Out of scope for Phase 2

| Item | When |
|---|---|
| Session management UI (list and revoke other sessions, log out everywhere) | Later (D11) |
| Message send and edit rate limits; typing throttle | Phase 4 (REST send path) and Phase 6 |
| `express.json` 16 kB limit and Socket.io `maxHttpBufferSize` | Phase 4, with the REST write path |
| zod schemas for socket payloads | Phase 4, when `new_message` is replaced |
| Content Security Policy on the SPA; self-hosted fonts | Phase 8 |
| User rooms, conversation rooms, membership and authorization | Phase 3 |
| Protocol-version handshake | Phase 5 |
| Email verification, password reset, password change | Not planned yet |
| Shared rate-limit store, multiple instances | Not planned (D16) |
| Custom domain | Later (D4) |

---

## 15. Release runbook (prepared, not executed in Phase 2)

When the maintainer decides to release Phase 2. Accounts and messages are kept; every user is logged out once, because their JWTs stop working.

**Before starting:** CI is green on the draft PR, and any commit on `main` that `phase-2` lacks has been merged into `phase-2`. Note the current Render settings for the rollback.

1. **Migrate production** from an up-to-date checkout of `phase-2`: `cd server && DATABASE_URL='<direct Neon URL, sslmode=verify-full>' npm run migrate`. Only `0003_sessions` is applied. It only adds a table, so the running Phase 1 server is unaffected. This step and every other production step are the maintainer's.
2. **Render environment:** in `DATABASE_URL`, change `sslmode=require` to `sslmode=verify-full`; set `TRUST_PROXY=1`; confirm `NODE_ENV=production` (set it if missing, because the cookie depends on it); set `CLIENT_URL` to the app's public URL (the Render URL). Save without deploying if Render offers that.
3. **Topology:** set Render's root directory to the repository root, with build `npm ci --prefix client && npm run build --prefix client && npm ci --include=dev --prefix server && npm run build --prefix server` and start `npm start --prefix server`.
4. **Merge:** mark the PR ready and merge it with a merge commit: `gh pr ready <n> && gh pr merge <n> --merge`. Render deploys `main`.
5. **Smoke test** on the live site:
   - Sign up, reload (still logged in), log out in one tab: the chat in the same browser's other tab disconnects. Log in again.
   - In devtools the cookie is `__Host-relay_session` with `HttpOnly`, `Secure` and `SameSite=Lax`, and `document.cookie` does not show it.
   - The 11th wrong password in a row for one email gets 429.
6. **Check `trust proxy`:** Render's request logs show `ip` equal to your public IP, and a request sent with `X-Forwarded-For: 1.2.3.4` still logs your IP. If not, adjust `TRUST_PROXY` and repeat.
7. **Clean up:** delete `JWT_SECRET` from Render (nothing reads it any more). Turn the Vercel project into the redirect or remove it.
8. **Record** the release in this plan and update the status lines (README, `docs/v2-design.md`, CLAUDE.md).

**Rollback:** revert the merge on `main` (`git revert -m 1 <merge commit>`, then push), and restore the Render settings noted before step 1 and the Vercel project. The `sessions` table can stay, because Phase 1 ignores it. Users log in again under Phase 1.

---

## 16. Decisions confirmed at approval

Confirmed by the maintainer on 2026-09-28. Relay is a portfolio project, not a commercial product, and it runs on free tiers; the recommendations were weighed with that in mind.

| # | Question | Decision |
|---|---|---|
| 1 | **Production cookie topology** (D4 open item, design §6): **A.** serve the SPA from Express, one origin and no CORS; **B.** a custom domain with `app.` and `api.` subdomains, configuration only but a yearly fee. Rejected: `SameSite=None` (Safari blocks third-party cookies) and proxying the API through Vercel rewrites (believed not to carry WebSockets, design §8). | **A. Serve the SPA from Express**, because it costs nothing. The trade-off is accepted: on Render's sleeping free tier the first page load waits for the cold start, where Vercel would have shown the landing page at once. A custom domain stays under Later (D4). |
| 2 | **Workflow:** a long-lived branch, or commits straight to `main` (which would break production login until the topology is live) | **The long-lived `phase-2` branch** with draft PR #2, released by §15, as in Phase 1. |
| 3 | **Vercel previews of `phase-2`:** on (each preview is a Phase 2 client against the Phase 1 API, which cannot log in) or off | **Off**, through `git.deploymentEnabled` in `client/vercel.json` (M0). |
| 4 | **Password rules for existing accounts:** at signup only, or also force existing users with shorter passwords to reset (there is no reset flow) | **Signup only.** Existing accounts keep working. |
| 5 | **Defaults:** sessions with a 30-day absolute limit, a 7-day idle timeout, `last_seen_at` hourly and a sweep every 5 minutes; 10 failed logins per 15 minutes per IP and email; 5 signups per hour per IP | **As drafted, except 20 signups per hour per IP.** Everyone on one network (a class, a career fair) shares one public IP, so a demo to a group would hit 5 quickly. The login limit is per email as well, so it is unaffected. |
| 6 | **Logout scope:** this session only, or every session of the user | **This session only** (design §6). "Log out everywhere" belongs to the later session UI (D11). |
