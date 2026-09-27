# Relay — Phase 0 Implementation Plan

**Status:** ✅ **Complete** (2026-09-27). All 11 tasks are done and verified; see [§16 Completion record](#16-completion-record) and [§17 Handoff to Phase 1](#17-handoff-to-phase-1).
**History:** approved as the lean Phase 0. Revised 2026-09-27 after D6 changed (existing data is not preserved; V2 starts with a fresh database), which removed the production backup and fact-gathering tasks. Task 10 was later reduced in scope (see §12).
**Scope source:** the approved lean Phase 0 plan. Background: `docs/current-state-audit.md`, `docs/v2-design.md`.
**Rule:** if a step seems to need something not listed here, stop and ask. Do not expand the scope.

---

## 1. Goal

Build the minimum foundation needed to start Phase 1 (the V2 data model) safely:

- a local Postgres with dev and test databases, built entirely by a migration runner;
- incremental TypeScript on the server;
- a small set of backend tests running against real Postgres;
- one CI workflow;
- config validation, centralized error handling, basic logging and graceful shutdown;
- fixes for the approved audit bugs;
- an accurate README.

Phase 0 does not implement any V2 features, design the V2 schema, or change socket events or authentication. The existing codebase is the starting point. The V2 schema is designed from scratch in Phase 1, following `docs/v2-design.md` §4.

Tasks are numbered in implementation order.

---

## 2. Prerequisites / safety checks

- [x] **Production is not touched in Phase 0,** except for the Render build/start command change in Task 1.
  - The production database is left as it is.
  - Its data is not preserved (D6). V2 runs on a fresh database, provisioned when Phase 1 is first deployed (see §15).
- [x] **The developer makes every production-side change** (the Render settings). Claude Code does not connect to production.
- [x] Tools are installed locally: Docker, and the Node version chosen in Task 3. `psql` is optional, for inspecting local databases.
- [x] Tests only ever target a database whose name ends in `_test`.
- [x] Do not convert existing JS files to TS. Do not touch socket events, JWT handling or the schema; Task 4's initial migration reproduces the current schema without changing it. D5 and D9 are not exercised in Phase 0.
- [x] Never commit `.env` files.
- [x] One task per commit or PR. Run lint, typecheck and tests before each commit, once they exist.

---

## 3. Task 1 — TypeScript + ESLint

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
- [x] The server builds from `dist/` and runs in production.
- [x] Typecheck passes in both projects.
- [x] Server lint passes.

---

## 4. Task 2 — Client lint fix

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
- [x] Client lint is clean with no rule disabled.

---

## 5. Task 3 — CI

**Objective:** one GitHub Actions job that runs lint, typecheck, tests and build on every PR and every push to `main`.

**Files likely to change:** `.github/workflows/ci.yml` (new).

**Implementation steps**
1. Choose one Node major version: the one used locally. Use it in CI, and confirm Render uses the same one when making the Task 1 settings change.
2. Client: `npm ci`, `lint`, `typecheck`, `build`.
3. Server: `npm ci`, `lint`, `typecheck`, `build`.
4. When Task 5 lands, add:
   - a Postgres service container at the version pinned in Task 4;
   - a server `npm test` step, with `DATABASE_URL` pointing at `relay_test`.
5. CI runs no deploys and needs no production secrets.

**Tests/verification**
- A PR shows a green run.
- A branch with a deliberately failing test shows a red run. Delete the branch afterwards.

**Definition of done**
- [x] CI runs all four checks for both projects and is green on `main`.

---

## 6. Task 4 — Local Postgres + migrations

**Objective:** versioned migrations, and two local databases built from them from scratch.

**Files likely to change**
- `docker-compose.yml` (new, at the repo root)
- `server/package.json`
- `server/migrations/` (new)
- `.env.example` or the README env section

**Implementation steps**
1. Add `docker-compose.yml` with one Postgres service and a named volume.
   - Pin one Postgres major version (default: 17).
   - Use the same version in CI, and for the fresh production database when it is created.
2. Create two databases: `relay_dev` and `relay_test`.
3. Add `node-pg-migrate` as a server dev dependency.
4. Add scripts: `migrate` (up), `migrate:down` and `migrate:create`. Migrations read the database URL from the environment.
5. **Verify** whether the installed node-pg-migrate version supports SQL-file migrations. If it does not, use its JS format with raw SQL via `pgm.sql()`.
6. Create `0001_initial`, which reproduces the current `users` and `messages` tables as defined in `README.md` ("Create the database") and used by the current code.
   - Do not improve this schema.
   - Phase 1 replaces these tables with the V2 schema.
7. Run `npm run migrate` against `relay_dev` and `relay_test`.

**Tests/verification**
- `npm run migrate` creates both tables in each database. A second run reports nothing to run.
- `npm run migrate:down` followed by `npm run migrate` succeeds.
- The app runs locally against `relay_dev`: signup, login and sending a message all work.

**Definition of done**
- [x] `docker compose up` followed by `npm run migrate` works from scratch.
- [x] `relay_dev` and `relay_test` are created only by migrations.

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
8. Add `test` and `test:watch` scripts, and add the test step to CI (Task 3, step 4).

**Tests/verification**
- `npm test` passes locally, and passes twice in a row.
- Pointing the tests at a database not ending in `_test` aborts before any query runs.

**Definition of done**
- [x] The harness works for REST and sockets.
- [x] The tests above pass locally and in CI.
- [x] The app factory split causes no behavior change.

---

## 8. Task 6 — Environment validation

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
- [x] `grep process.env server/` finds hits only in `config/env.ts` (and in test setup).
- [x] The server fails fast on bad config.

---

## 9. Task 7 — Error handling

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
- [x] Every REST error uses the envelope.
- [x] The UI shows server error messages.

---

## 10. Task 8 — Logging

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
- [x] No `console.*` calls remain in the server.
- [x] Secrets are redacted.

---

## 11. Task 9 — Graceful shutdown + pool error

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
- [x] A pool error is logged and survived.
- [x] Shutdown is clean, with no errors in the log.

---

## 12. Task 10 — Approved bug fixes

**Objective:** fix audit §4 item 6 (signup race returns 500) and the client API port mismatch.

**Scope (reduced, decided 2026-09-27):** audit §4 item 7 (over-length username returns 500) moved to Phase 1. Phase 1 replaces the username and email rules, so length and format validation is written once there instead of twice. See the deferred list (§15).

**Files likely to change**
- `server/routes/auth.js`
- `client/src/api/axios.js`
- `server/test/`

**Implementation steps**
1. **Fix 6:** keep the existing pre-check, and also catch the Postgres unique violation (`23505`) on insert and return 409 via `AppError`.
2. **Port:** change the fallback in `client/src/api/axios.js` to `:5001`, matching `socket.js` and the server.

**Tests/verification**
- Concurrent signups with the same email produce exactly one success and 409s, never a 500.
- A duplicate that the pre-check misses (the lost race) returns 409 for both the email and the username constraint.
- Existing signup tests still pass.
- A client build without `VITE_API_URL` sends REST calls to `:5001`.

**Definition of done**
- [x] The signup race never returns 500.
- [x] The client uses one consistent fallback port.

---

## 13. Task 11 — README/cleanup

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
   - replace the schema SQL, in both local setup and the Neon deployment steps, with a pointer to `server/migrations/` and `npm run migrate`.
4. Add a local setup section:
   - prerequisites;
   - `docker compose up`;
   - env vars;
   - `npm run migrate`;
   - dev servers;
   - `npm test`.
5. Link `docs/`: the audit, the V2 design and this plan.

**Tests/verification**
- Follow the README from a fresh clone and a clean Docker volume. Every step works.
- The client builds after the deletions.

**Definition of done**
- [x] The README is accurate and the setup works as written.
- [x] No dead template files remain.

---

## 14. Final Phase 0 verification checklist

- [x] A fresh clone can run `docker compose up`, `npm run migrate` and `npm test`, and everything passes. *(Task 11: README followed from a fresh clone and a clean Docker volume; 35/35 tests.)*
- [x] `relay_dev` and `relay_test` are built from scratch by migrations. *(`0001_initial` via `npm run migrate` and the test global setup.)*
- [x] CI is green on `main`: lint, typecheck, test and build for both projects. *(Every Phase 0 commit, through `6f4d188`.)*
- [x] A missing required env var stops startup and names the variable. *(Exit 1 with a fatal log naming it; values never shown.)*
- [x] Every REST error uses the envelope, and the UI shows server error messages. *(Task 7 tests and browser check.)*
- [x] A pool error no longer kills the process, and SIGTERM exits cleanly. *(Task 9: real `pg_terminate_backend` test; SIGTERM exit 0 in under 100 ms; clients reconnect.)*
- [x] Concurrent or duplicate signups return 409. *(Task 10: 5-way race gives one 201 and four 409s.)*
- [x] Client and server lint are clean.
- [x] Production still works. Only the Render build/start command changed, and the production database was not touched. *(Read-only check on 2026-09-27: the live API serves the new build — JSON 404/401 envelopes, correct CORS, `/api/ping` 200. No queries or writes were run against the production database. See known issues in §16 for an intermittent 520.)*
- [x] Nothing from the deferred list below was implemented.

---

## 15. Explicitly deferred work

**Deferred to a later phase**

| Item | When |
|---|---|
| Fresh production database: create it empty, run migrations, rotate `JWT_SECRET` (`docs/v2-design.md` §4) | When Phase 1 is first deployed |
| `packages/shared` and npm workspaces | When the first type is genuinely shared (likely Phase 3–4) |
| Audit §4 items 3–5 (load race, reconnect gap, lost sends) | Phases 4–5 |
| Audit §4 item 7 (over-length username returns 500): server-side signup length/format validation | Phase 1, with the V2 signup rules |
| Audit §4 item 8 (toast IDs) | Phase 4 `Chat.jsx` rewrite |
| Client Vitest setup | Phase 4 |
| Playwright | Phase 5 (offline/reconnect test) |
| Database TLS verification, rate limiting, helmet, `trust proxy`, login timing fix, password rules | Phase 2 |
| V2 username/email normalization and format rules | Phases 1–2 |
| Zustand or other state libraries | Only if plain React state proves insufficient (D9) |
| ADRs | Alongside the phase that implements each decision |
| Prettier | Optional: add a config and format files as they are touched. No formatting pass |

**Not worth doing for this project**

- Production backups, production data inspection, and migrating existing data (D6).
- Characterization tests for behavior V2 replaces (single-room events, typing timers, `online_count`, the 401/403 split).
- Drift-detection scripts.
- Branch protection, deploy gating, pre-deploy migration hooks, and deployment orchestration.
- Request-ID middleware, health/readiness endpoints, log shipping, APM, monitoring and alerting.
- Staging environments and Neon preview branches.
- Redis, multiple instances, queues and containerized deploys. Docker is for local Postgres only.
- Coverage thresholds and load testing.

---

## 16. Completion record

Phase 0 was completed on 2026-09-27. One task per commit, all on `main`, all with green CI.

| Task | Commit | Notes and deviations from the plan |
|---|---|---|
| 1. TypeScript + ESLint | `ce3ae79` | Render build/start changed by the maintainer to `npm ci --include=dev && npm run build` / `npm start`. |
| 2. Client lint fix | `e6444e7` | The context was split into three files (`AuthProvider.jsx`, `authContext.js`, `useAuth.js`), because exporting the context from the provider file fails the same lint rule. |
| 3. CI | `f565fd9` | Node 24, `actions/checkout@v7` and `actions/setup-node@v7`. The optional deliberately red run was not performed. |
| 4. Local Postgres + migrations | `04ed98c` | PostgreSQL 17 on host port **5433** (local Postgres installs use 5432). Local `DATABASE_URL` needs `?sslmode=disable`. SQL migrations (node-pg-migrate 9). |
| 5. Test harness | `26309ad` | Vitest 5. The database guard has three layers: config, the pool's connection string, and an in-database check before `TRUNCATE`. |
| 6. Environment validation | `2c6e15e` | `.env` loading moved into `config/env.ts`, because ES module imports run before the importing file's code. The server now needs the build (or `tsx`); plain `node index.js` no longer works. |
| 7. Error handling | `b48e018` | Added `BAD_REQUEST` so body errors keep their 4xx status (e.g. 413). The login fallback message became "Login failed. Please try again." |
| 8. Logging | `c9b0988` | Also redacts `req.headers.cookie` and Postgres `err.detail`; `dotenv` set to quiet; the config-failure line uses a default pino instance. |
| 9. Graceful shutdown + pool error | `98c6d37` | Also redacts `err.client`: pg-pool attaches the whole client, including the database password, to pool errors. Found by the reproduction test. |
| 10. Bug fixes | `6f4d188` | Reduced scope (see §12): audit §4.7 moved to Phase 1. |
| 11. README/cleanup | *(this change)* | README verified end to end from a fresh clone and a clean Docker volume. |

**Final state:** 35 server tests (auth, messages, sockets, errors, env, logger redaction, pool), CI green, lint/typecheck/build clean in both projects.

**Known issues carried forward**
- Audit §4.7: a username over 50 characters still returns 500. Fixed with the V2 signup validation in Phase 1.
- Production: during the Task 11 check, the first request after about a minute of inactivity twice returned **520** from Render's proxy; immediate retries returned 200. Not reproduced with 10-second gaps, cause unknown. Watch for it once the app is in regular use.
- `npm audit` reports 6 pre-existing advisories in transitive dependencies of `socket.io` and `express` (fixes available). Not addressed in Phase 0.
- The client's ESLint config only lints `.js`/`.jsx`, so client `.ts` files are type-checked but not linted.
- With pino-http's default settings, request lines for 4xx and 5xx responses are logged at `info`; the errors themselves are logged separately at `error`.
- In development, pressing Ctrl-C twice force-kills the server (`tsx watch` behavior).
- During Task 5, one test run failed once (all of `messages.test.ts`) and never recurred in more than 100 runs.

---

## 17. Handoff to Phase 1

**Starting point:** the single-room app on the Phase 0 foundation above. Phase 1 builds the V2 schema from `docs/v2-design.md` §4 on a fresh database (D6).

**First step:** write `docs/phase-1-implementation-plan.md` in the same format as this plan, and get it approved before any code, as was done for Phase 0.

**Carried over into Phase 1**
- Audit §4.7: server-side signup validation (length and format) with the V2 username/email rules.
- From the deferred list: the fresh production database, running migrations on it, and rotating `JWT_SECRET` when Phase 1 is first deployed.
- ADRs for decisions Phase 1 implements (for example D10, integer IDs), per the deferred list.

**Decisions to settle while writing the Phase 1 plan**
1. **Deploy Phase 1 to production, or keep production on Phase 0 until a later phase?** Deploying means a fresh Neon database, a rotated `JWT_SECRET`, and every existing account disappearing (D6).
2. **Migration layout:** add `0002` that drops the Phase 0 tables and creates the V2 schema (recommended: `0001` has already run in every environment), rather than rewriting `0001`.
3. **Keep the single-room UI working on the V2 schema** by seeding `#general`, as `docs/v2-design.md` §4 describes, until Phase 4 replaces it.
4. **Include `seq` / `last_seq` now** (the preferred D5 model) or defer ordering columns until the D5 decision point in Phase 5.
