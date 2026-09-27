# Relay — Phase 0 Implementation Plan

**Status:** Approved (lean Phase 0).
**Scope source:** the approved lean Phase 0 plan. Background: `docs/current-state-audit.md`, `docs/v2-design.md`.
**Rule:** if a step seems to need something not listed here, stop and ask. Do not expand the scope.

---

## 1. Goal

Build the minimum foundation needed to start Phase 1 (the V2 data model) safely:

- a production backup and a record of production facts;
- a migration runner with a baseline migration;
- incremental TypeScript on the server;
- a small set of backend tests running against real Postgres;
- one CI workflow;
- config validation, centralized error handling, basic logging and graceful shutdown;
- fixes for the approved audit bugs;
- an accurate README.

Phase 0 does not implement any V2 features, change the schema, or change socket events or authentication.

**Implementation order** (this differs from the section order):

1. Tasks 1–2
2. Tasks 4, 12 and 6 (CI without tests)
3. Task 3
4. Task 5 (and add the test step to CI)
5. Tasks 7–11
6. Task 13

---

## 2. Prerequisites / safety checks

- [ ] **Production is read-only in Phase 0.** The only production-side change is the Render build/start command (Task 4). Marking production's baseline happens at the start of Phase 1, not now.
- [ ] **The developer runs production commands** (Tasks 1–2 and the Render settings change). Claude Code may prepare the commands and queries, but does not connect to production without explicit approval each time.
- [ ] Add `backups/`, `*.dump` and `*.sql.gz` to `.gitignore` **before** creating any dump. Never commit dumps or `.env` files.
- [ ] Tools are installed locally: Docker, and the `pg_dump`/`pg_restore`/`psql` client at the **same major version or newer** than production's server.
- [ ] Tests only ever target a database whose name ends in `_test`.
- [ ] Do not convert existing JS files to TS. Do not touch socket events, JWT handling or the schema. D5 and D9 are not exercised in Phase 0.
- [ ] One task per commit or PR. Run lint, typecheck and tests before each commit, once they exist.

---

## 3. Task 1 — Production backup

**Objective:** a restorable full backup of production before anything else happens.

**Files likely to change:** `.gitignore` (the backup file itself stays outside git).

**Implementation steps**
1. Get the production connection string from Render's environment settings. Use Neon's direct connection if available.
2. Run `pg_dump` with the custom format (`-Fc`) to `backups/relay-prod-<date>.dump`.
3. Record the dump date and the `pg_dump` version used, for `docs/production-facts.md` (Task 2).

**Tests/verification**
- `pg_restore --list` on the file succeeds and lists the `users` and `messages` data.
- `git status` does not show the dump.

**Definition of done**
- [ ] A dump file exists locally, is readable by `pg_restore`, and is ignored by git.

---

## 4. Task 2 — Production facts

**Objective:** record the facts Phase 1's migration depends on, with no PII.

**Files likely to change:** `docs/production-facts.md` (new).

**Implementation steps**

Run everything in a read-only session (`SET default_transaction_read_only = on`). Record the results in `docs/production-facts.md`:

1. `pg_dump --schema-only` → save to `backups/relay-prod-schema-<date>.sql`.
2. `SHOW server_version` and `SHOW timezone`.
3. Row counts for `users` and `messages`.
4. Number of emails that collide after `lower()`.
5. Number of usernames that collide after `lower()`.
6. Number of usernames failing `^[a-z0-9_]{3,32}$` after `lower()`.
7. Number of messages with empty (trimmed) content, and number longer than 4000 characters.
8. Differences between the actual schema and the schema in `README.md`: column types, indexes, constraints.
9. Whether production uses `DATABASE_URL` or `DB_*`, and whether the URL is Neon's pooled connection (`-pooler` in the host) or the direct one.
10. Render's Node version, its build and start commands, and its root directory.

**Tests/verification**
- The facts file contains counts and settings only: no emails, usernames or message text.

**Definition of done**
- [ ] `docs/production-facts.md` answers items 1–10.
- [ ] Any Phase 1 blockers (collisions, invalid usernames, content outside 1–4000 characters) are listed explicitly.

---

## 5. Task 3 — Local Postgres + migrations

**Objective:** versioned migrations with a baseline that matches production, plus two local databases.

**Files likely to change**
- `docker-compose.yml` (new, at the repo root)
- `server/package.json`
- `server/migrations/` (new)
- `.env.example` or the README env section
- `.gitignore`

**Implementation steps**
1. Add `docker-compose.yml` with one Postgres service at production's major version (Task 2) and a named volume.
2. Create two databases: `relay_dev` and `relay_test`.
3. Add `node-pg-migrate` as a server dev dependency.
4. Add scripts: `migrate` (up), `migrate:down` and `migrate:create`. Migrations read the database URL from the environment.
5. **Verify** in the installed node-pg-migrate version:
   - whether it supports SQL-file migrations; if not, use its JS format with raw SQL via `pgm.sql()`;
   - how to mark a migration as applied without running it; if there is no option, document a single `INSERT` into its tracking table.
6. Create `0001_baseline` from the production schema dump. Strip owner, ACL and `SET` noise; keep tables, sequences, constraints and indexes exactly as they are.
7. Check the baseline once by hand:
   1. Apply it to an empty scratch database.
   2. Run `pg_dump --schema-only` on that database.
   3. `diff` the result against the production schema dump. Resolve every difference that is not cosmetic.
8. Restore the full production dump into `relay_dev` with `pg_restore --no-owner --no-acl`.
9. Mark `0001_baseline` as applied in `relay_dev` using the method from step 5. This rehearses the procedure that will be used on production in Phase 1.
10. Run `npm run migrate` against `relay_test` to apply the baseline from scratch.

**Tests/verification**
- `npm run migrate` against `relay_dev` reports nothing to run.
- `relay_dev` row counts match `docs/production-facts.md`.
- `relay_test` has the same tables as production and is empty.

**Definition of done**
- [ ] `docker compose up` followed by `npm run migrate` works from scratch.
- [ ] The baseline matches the production schema.
- [ ] `relay_dev` holds the restored production data and is marked as baselined.

---

## 6. Task 4 — TypeScript + ESLint

**Objective:** new server code can be written in strict TypeScript without converting existing JS, and the server has a lint configuration.

**Files likely to change**
- `server/package.json`
- `server/tsconfig.json` and `server/tsconfig.build.json` (new)
- `server/eslint.config.js` (new)
- `client/package.json`
- `client/tsconfig.json` (new)
- Render build/start settings

**Implementation steps**
1. Server dev dependencies: `typescript`, `tsx`, `@types/node`, and `@types/*` for express, pg, bcrypt, jsonwebtoken and cors as needed.
2. `server/tsconfig.json`: `allowJs: true`, `checkJs: false`, `strict: true`, NodeNext module resolution, `outDir: dist`. `tsconfig.build.json` excludes the tests and migrations.
3. Scripts:
   - `dev`: `tsx watch index.js`
   - `build`: `tsc -p tsconfig.build.json`
   - `start`: `node dist/index.js`
   - `typecheck` and `lint`
4. **Check every runtime path** computed from `import.meta.url` or relative directories, especially the root `.env` loading. Build output in `dist/` sits one level deeper, so those paths must still resolve.
5. Server ESLint flat config using typescript-eslint's recommended rules. Fix or explicitly disable any existing violations; do not refactor.
6. Client: add `tsconfig.json` (`allowJs`, `noEmit`, `jsx: react-jsx`) and a `typecheck` script. Convert no files.
7. The developer updates Render's build command to `npm ci && npm run build` and its start command to `npm start`, then deploys this change **on its own**.

**Tests/verification**
- `npm run build`, `npm start`, `typecheck` and `lint` all pass locally in `server/`.
- `typecheck` passes in `client/`.
- After the Render deploy, login and sending a message work in production.

**Definition of done**
- [ ] The server builds from `dist/` and runs in production.
- [ ] Typecheck passes in both projects.
- [ ] Server lint passes.

---

## 7. Task 5 — Test harness

**Objective:** backend integration tests against `relay_test`, covering the behavior that V2 relies on.

**Files likely to change**
- `server/package.json`
- `server/vitest.config.ts` (new)
- `server/app.js` (new)
- `server/index.js`
- `server/test/` (new: setup, helpers, test files)

**Implementation steps**
1. Dev dependencies: `vitest`, `supertest`, `@types/supertest`, `socket.io-client`.
2. Move app construction from `index.js` into `app.js`, exporting a factory that returns `{ app, httpServer, io }` without listening. `index.js` keeps startup and `listen`. **This must not change any behavior.**
3. Global setup:
   1. Refuse to run unless the database name ends in `_test`.
   2. Run migrations against `relay_test`.
4. Before each test, truncate `users` and `messages` with `RESTART IDENTITY CASCADE`.
5. Set `fileParallelism: false`. After all tests, close `io` and the pool.
6. Helpers:
   - start the server on port 0;
   - create a user through the API;
   - connect an authenticated socket client.
7. Tests for **current** behavior. Read each handler first and assert what it actually does:
   - signup succeeds, and the stored password is a bcrypt hash;
   - login succeeds;
   - unknown email and wrong password produce the same status and body;
   - duplicate email and duplicate username return 409;
   - `GET /api/messages` without a token returns 401, and with a token returns the current shape and order;
   - the socket handshake rejects a missing or invalid token;
   - `new_message` is stored and another connected client receives `message` with the REST shape.
8. Add `test` and `test:watch` scripts.

**Tests/verification**
- `npm test` passes locally, and passes twice in a row.
- Pointing the tests at a database not ending in `_test` aborts before any query runs.

**Definition of done**
- [ ] The harness works for REST and sockets.
- [ ] The tests above pass.
- [ ] The app factory split causes no behavior change.

---

## 8. Task 6 — CI

**Objective:** one GitHub Actions job that runs lint, typecheck, tests and build on every PR and every push to `main`.

**Files likely to change:** `.github/workflows/ci.yml` (new).

**Implementation steps**
1. Set up Node at the version Render uses (from Task 2).
2. Client: `npm ci`, `lint`, `typecheck`, `build`.
3. Server: `npm ci`, `lint`, `typecheck`, `build`.
4. When Task 5 lands, add a Postgres service container at production's major version and a server `npm test` step using `DATABASE_URL` pointing at `relay_test`.
5. CI runs no deploys and needs no production secrets.

**Tests/verification**
- A PR shows a green run.
- A branch with a deliberately failing test shows a red run. Delete the branch afterwards.

**Definition of done**
- [ ] CI runs all four checks for both projects and is green on `main`.

---

## 9. Task 7 — Environment validation

**Objective:** the server refuses to start with missing or invalid config, and `process.env` is read in exactly one place.

**Files likely to change**
- `server/package.json` (add `zod`)
- `server/config/env.ts` (new)
- `server/index.js`, `server/app.js`, `server/db/connection.js`
- `server/routes/auth.js`, `server/middleware/verifyToken.js`, `server/socket/socketHandler.js`
- `server/test/`

**Implementation steps**
1. `config/env.ts` exports a parse function and a frozen config object.
2. Variables:
   - `NODE_ENV`, `PORT` and `CLIENT_URL`, keeping the current defaults;
   - `JWT_SECRET`, required and non-empty, **with no minimum length**;
   - `DATABASE_URL`, **or** the full set of `DB_*` variables (check the exact names in `connection.js`);
   - `LOG_LEVEL`, optional.
3. Keep the existing `.env` loading, and make sure it runs before parsing.
4. On failure, log the names of the invalid variables (never their values) and exit with code 1 before `listen`.
5. Replace every `process.env` read in the server with the config object.

**Tests/verification**
- Unit tests of the parse function:
  - a missing `JWT_SECRET` fails and names it;
  - having neither `DATABASE_URL` nor `DB_*` fails;
  - a valid input returns the config.
- Starting the server without `JWT_SECRET` exits with code 1 and a clear message.

**Definition of done**
- [ ] `grep process.env server/` finds hits only in `config/env.ts` (and in test setup).
- [ ] The server fails fast on bad config.

---

## 10. Task 8 — Error handling

**Objective:** all REST errors use `{ error: { code, message, details? } }`, and the client shows server error messages (fixes audit §4.1).

**Files likely to change**
- `server/lib/errors.ts` (new)
- `server/http/errorHandler.ts` and `server/http/notFound.ts` (new)
- `server/app.js`
- `server/routes/auth.js`, `server/routes/messages.js`, `server/middleware/verifyToken.js`
- `client/src/lib/errors.ts` (new)
- `client/src/pages/Login.jsx`, `client/src/pages/Signup.jsx`
- `server/test/`

**Implementation steps**
1. `AppError` carries `code`, `status`, `message` and optional `details`. Define only the error codes that existing responses need, as constants in `errors.ts`.
2. Convert every existing `{ error: string }` response to the envelope. **Keep the current status codes**, including the 401/403 split.
3. The global error handler:
   - `AppError` → its status and envelope;
   - `express.json` parse error → 400;
   - anything else → logged, then a generic 500 with no stack trace in the body.
4. Add a JSON 404 handler for unmatched `/api/*` routes. Mount it after the routes and before the error handler.
5. Client `getErrorMessage(err, fallback)` accepts both the old `{error: string}` and the new envelope. Use it in `Login.jsx` and `Signup.jsx`.
6. The socket `error` event stays `{ message }`, unchanged.

**Tests/verification**
- An unknown `/api` route returns 404 with the envelope.
- Malformed JSON returns 400 with the envelope.
- A forced internal error returns 500 with no stack in the body.
- Update the Task 5 assertions to expect the envelope.
- Manually: signing up with a taken email shows the server's message in the UI.

**Definition of done**
- [ ] Every REST error uses the envelope.
- [ ] The UI shows server error messages.

---

## 11. Task 9 — Logging

**Objective:** structured logs with no secrets, using default pino settings.

**Files likely to change**
- `server/package.json` (add `pino`, `pino-http`)
- `server/lib/logger.ts` (new)
- `server/app.js`, `server/index.js`, `server/db/connection.js`, `server/socket/socketHandler.js`
- `server/http/errorHandler.ts`

**Implementation steps**
1. `logger.ts` creates a single pino logger, with its level taken from config.
2. Add `pino-http` middleware with default settings. Redact `req.headers.authorization` and any `password` field.
3. Replace the server's `console.*` calls with the logger.
4. Tests set `LOG_LEVEL=silent`.

**Tests/verification**
- Manually: a login request produces a JSON log line that contains neither the password nor the `Authorization` header.
- Test output is not flooded with logs.

**Definition of done**
- [ ] No `console.*` calls remain in the server.
- [ ] Secrets are redacted.

---

## 12. Task 10 — Graceful shutdown + pool error

**Objective:** a clean exit on SIGTERM/SIGINT, and an idle-connection failure no longer crashes the process (fixes audit §4.2).

**Files likely to change**
- `server/db/connection.js`
- `server/index.js`
- `server/test/`

**Implementation steps**
1. Register `pool.on('error')`: log the error and do not exit.
2. On SIGTERM or SIGINT:
   1. log the signal;
   2. call `io.close()`, which also closes the HTTP server;
   3. call `pool.end()`;
   4. exit with code 0.
3. Add a forced-exit timer of about 10 s (`unref`'d), and ignore repeated signals.

**Tests/verification**
- Test: emitting `error` on the pool does not throw, and the process continues.
- Manually: with a browser tab connected, `kill -TERM` the server; it exits cleanly within a few seconds. After a restart, the tab's socket reconnects.

**Definition of done**
- [ ] A pool error is logged and survived.
- [ ] Shutdown is clean, with no errors in the log.

---

## 13. Task 11 — Approved bug fixes

**Objective:** fix audit §4 items 6 (signup race returns 500) and 7 (long username returns 500), and the client API port mismatch.

**Files likely to change**
- `server/routes/auth.js`
- `client/src/api/axios.js`
- `server/test/`

**Implementation steps**
1. **Fix 6:** keep the existing pre-check, and also catch the Postgres unique violation (`23505`) on insert and return 409 via `AppError`.
2. **Fix 7:** validate the signup body server-side with zod:
   - required fields;
   - `username` and `email` maximum lengths matching the **current** column sizes (confirm them from Task 2's schema).

   Invalid bodies return 400. Do **not** add V2 username format rules or password rules yet.
3. **Port:** change the fallback in `client/src/api/axios.js` to `:5001`, matching `socket.js` and the server.

**Tests/verification**
- Two concurrent signups with the same email produce exactly one success and one 409, never a 500.
- A 51-character username returns 400.
- An email over the column limit returns 400.
- Existing signup tests still pass.

**Definition of done**
- [ ] Neither case returns 500.
- [ ] The client uses one consistent fallback port.

---

## 14. Task 12 — Client lint fix

**Objective:** `npm run lint` passes in `client/` (fixes audit §4.9).

**Files likely to change**
- `client/src/context/AuthContext.jsx`
- `client/src/context/useAuth.js` (new)
- the client files that import the hook

**Implementation steps**
1. Move the non-component export flagged at `AuthContext.jsx:41` into `useAuth.js`.
2. Update imports. Behavior stays the same.

**Tests/verification**
- `npm run lint` passes.
- Manually: signup, login, logout and the protected route still work.

**Definition of done**
- [ ] Client lint is clean with no rule disabled.

---

## 15. Task 13 — README/cleanup

**Objective:** a clone of the repo can be set up by following the README, and dead files are removed.

**Files likely to change**
- `README.md`
- `client/README.md` (delete)
- `client/src/App.css`, `client/src/assets/{hero.png,react.svg,vite.svg}`, `client/public/icons.svg` (delete)
- `server/index.js`, `client/src/api/axios.js`, `server/db/connection.js` (comments only)

**Implementation steps**
1. Before deleting each dead file, `grep` for references to it, including `index.html`.
2. Remove the `// ← NEW` markers, the "interviews" comment in `axios.js`, and the Railway reference in `connection.js`.
3. README fixes:
   - remove the `LICENSE` link, unless you decide to add a license;
   - correct the `cd` path;
   - remove the outdated `DATABASE_URL` instruction;
   - replace the schema section with a pointer to `server/migrations/`.
4. Add a local setup section:
   - prerequisites;
   - `docker compose up`;
   - env vars;
   - `npm run migrate`;
   - dev servers;
   - `npm test`.
5. Link `docs/` (audit, V2 design, this plan, production facts).

**Tests/verification**
- Follow the README from a fresh clone and a clean Docker volume. Every step works.
- The client builds after the deletions.

**Definition of done**
- [ ] The README is accurate and the setup works as written.
- [ ] No dead template files remain.

---

## 16. Final Phase 0 verification checklist

- [ ] A production backup exists and is restorable. `docs/production-facts.md` is complete and contains no PII.
- [ ] A fresh clone can run `docker compose up`, `npm run migrate` and `npm test`, and everything passes.
- [ ] `relay_dev` holds the restored production data and is marked as baselined. `relay_test` is migrated from the baseline.
- [ ] CI is green on `main`: lint, typecheck, test and build for both projects.
- [ ] A missing required env var stops startup and names the variable.
- [ ] Every REST error uses the envelope, and the UI shows server error messages.
- [ ] A pool error no longer kills the process, and SIGTERM exits cleanly.
- [ ] Concurrent or duplicate signups return 409, and an over-length username returns 400.
- [ ] Client and server lint are clean.
- [ ] Production still works: no schema changes, and only the Render build/start command changed.
- [ ] Nothing from the deferred list below was implemented.

---

## 17. Explicitly deferred work

**Deferred to a later phase**

| Item | When |
|---|---|
| Marking production as baselined (after a fresh backup) | Start of Phase 1 |
| `packages/shared` and npm workspaces | When the first type is genuinely shared (likely Phase 3–4) |
| Audit §4 items 3–5 (load race, reconnect gap, lost sends) | Phases 4–5 |
| Audit §4 item 8 (toast IDs) | Phase 4 `Chat.jsx` rewrite |
| Client Vitest setup | Phase 4 |
| Playwright | Phase 5 (offline/reconnect test) |
| Database TLS verification, rate limiting, helmet, `trust proxy`, login timing fix, password rules | Phase 2 |
| V2 username/email normalization and format rules | Phases 1–2 |
| Zustand or other state libraries | Only if plain React state proves insufficient (D9) |
| ADRs | Alongside the phase that implements each decision |
| Prettier | Optional: add a config and format files as they are touched. No formatting pass |

**Not worth doing for this project**

- Characterization tests for behavior V2 replaces (single-room events, typing timers, `online_count`, the 401/403 split).
- Drift-detection scripts and formal restore rehearsals.
- Branch protection, deploy gating, pre-deploy migration hooks, and deployment orchestration.
- Request-ID middleware, health/readiness endpoints, log shipping, APM, monitoring and alerting.
- Staging environments and Neon preview branches.
- Redis, multiple instances, queues and containerized deploys. Docker is for local Postgres only.
- Coverage thresholds and load testing.
