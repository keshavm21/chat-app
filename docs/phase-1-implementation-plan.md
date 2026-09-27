# Relay — Phase 1 Implementation Plan

**Status:** ✅ **Complete** (2026-09-27) on the `phase-1` branch. Milestones M0–M4 are done and verified; see [§15 Completion record](#15-completion-record) and [§16 Handoff](#16-handoff-to-the-cutover-and-phase-2). Production stays on Phase 0 until the cutover ([§13](#13-production-cutover-runbook-prepared-not-executed-in-phase-1)), which the maintainer schedules.
**History:** approved 2026-09-27; the maintainer's decisions on the open questions are recorded in [§14](#14-decisions-confirmed-at-approval).
**Scope source:** `docs/v2-design.md` (§4 data model, §5 message delivery, §9 Phase 1) and the handoff in `docs/phase-0-implementation-plan.md` §17, shaped by the four decisions in §2.
**Rule:** if a step seems to need something not listed here, stop and ask. Do not expand the scope.

---

## 1. Goal

Replace the Phase 0 schema with the V2 data model from `docs/v2-design.md` §4, on a fresh database, while the existing single-room chat keeps working:

- migration `0002` creates the V2 tables, constraints and indexes and seeds a public `#general` channel;
- the current app reads and writes `#general` through the new schema, with per-conversation message ordering (`seq`) assigned by the database;
- signup and login validate and normalize input with the V2 username and email rules (fixes audit §4.7);
- every constraint and the ordering guarantees are covered by tests.

Phase 1 does **not** add conversation endpoints or UI, sessions, rooms, the REST send path, client-side ordering or any other later-phase feature (§12). Production stays on Phase 0 throughout (§2, decision 1).

---

## 2. Decisions this plan implements

| # | Decision | How this plan applies it |
|---|---|---|
| 1 | **Production stays on Phase 0** while Phase 1 is developed and verified locally | Render deploys every push to `main`, so all Phase 1 work happens on a long-lived `phase-1` branch; nothing Phase 1 reaches `main` in this phase (§4, Milestone 0). The production cutover is a separate, later decision with a prepared runbook (§13). |
| 2 | **Migration `0002`** for the V2 schema; `0001` is not rewritten | `0002_v2_schema.sql` drops the Phase 0 tables and creates the V2 schema. Its down migration restores the Phase 0 schema exactly, so `migrate:down` still works (Milestone 2). |
| 3 | **Keep the chat working on the new schema** by seeding a public `#general`, then build further conversations incrementally | `0002` seeds `#general`; signup adds every new user to it; history and sending go through it. The schema supports channels and DMs from day one (tested at the database level), but creating other conversations is left to Phase 3, where the roadmap puts conversation endpoints, authorization and UI (confirmed, §14). |
| 4 | **Add the message-ordering fields now**, as far as the approved design requires | `messages.seq`, `conversations.last_seq` and `last_message_at`, and `conversation_members.last_read_seq` are created in `0002`, and sends assign `seq` with the design's counter transaction. `seq` is also added to message payloads (additive), so later phases don't retrofit it. `rev`/`last_rev` are not ordering fields: they track edits and deletes for the full D5 model, and are added later, when edit and delete sync requires them (confirmed, §14). |

---

## 3. Starting state (verified 2026-09-27)

- `main` at `06b1b01` ("docs: mark phase 0 complete"), clean, CI green; no other branches.
- Local Docker Postgres 17.11: `relay_dev` and `relay_test` both at `0001_initial`, both empty. `gen_random_uuid()` is built in (Postgres 13+).
- Server: 35 tests pass; lint, typecheck and build clean in both projects.
- Code that depends on the Phase 0 schema, and therefore changes in Milestone 2:
  - `server/routes/auth.js` (the `password` column, the `users` queries)
  - `server/routes/messages.js` (history query with `user_id`, `username`)
  - `server/socket/socketHandler.js` (the `INSERT INTO messages (user_id, username, content)`)
  - tests: `test/setup.ts` (per-test `TRUNCATE`), `auth.test.ts`, `messages.test.ts`, `socket.test.ts`
- CI runs on pushes to `main` and on every pull request (any target branch). Render auto-deploys `main`.

---

## 4. Workflow and safety rules

- [x] **All Phase 1 commits go to the `phase-1` branch, never to `main`.** A draft pull request `phase-1 → main` (marked "do not merge until the production cutover") makes CI run on every push to the branch.
- [x] Commit directly to `phase-1`; the draft PR is the only pull request and exists to run CI (no per-milestone PRs). One task per commit, lint/typecheck/tests before each commit. A milestone is done when CI is green on the branch and its verification and definition of done are met; the next milestone starts only after the maintainer approves.
- [x] Phase 0 fixes still go to `main` (production), and `main` is merged into `phase-1` afterwards so the branch doesn't drift.
- [x] Never connect to or modify the production database. `0002` runs only against `relay_dev`, `relay_test`, CI's database and scratch databases.
- [x] Tests only run against a local `*_test` database (the Phase 0 guard stays in place).
- [x] Vercel builds preview deployments of branch pushes, and those previews call the **production** API. Phase 1 client changes (Milestone 1's signup form) are compatible with the Phase 0 API, so this is harmless, so previews stay enabled (confirmed, §14).
- [x] Limits used by both validation and the database (username pattern, email length, message length) live in one module (`server/lib/limits.ts`); the migration repeats them in SQL, and tests check that both agree.

---

## 5. Milestones

Each milestone ends with the app working and CI green on `phase-1`. They are done strictly in order.

| Milestone | Delivers | Depends on |
|---|---|---|
| **M0 — Branch and baseline** | `phase-1` branch, draft PR, green baseline CI; production provably untouched | — |
| **M1 — V2 identity rules on the current schema** | Signup/login validation and normalization with the V2 username and email rules; audit §4.7 fixed | M0 |
| **M2 — V2 schema and `#general` cutover** | Migration `0002`, constraint tests, the app running on the V2 schema through `#general`, `seq` assigned on send | M1 |
| **M3 — Ordering guarantees** | The full send transaction from the design (membership guard, gapless rollback, sender read position), message length limit, concurrency tests | M2 |
| **M4 — Phase 1 verification and handoff** | Fresh-clone verification, ADRs, docs, completion record, prepared cutover runbook | M3 |

Why this order: M1 adds the application-level rules first, on a schema that already accepts them, so the app never meets a database constraint it can't satisfy. M2 is the one unavoidable big step: dropping the Phase 0 tables forces the schema, the queries and the tests to change together. M3 then proves the ordering properties on a working system.

---

## 6. Milestone 0 — Branch and baseline

**Objective:** a place to build Phase 1 where CI runs on every push and nothing reaches production.

**Files likely to change:** none (repository settings only).

**Steps**
1. Commit this plan (once approved) to `main`, so both branches share it.
2. Create `phase-1` from `main` and push it.
3. Open a draft pull request `phase-1 → main` titled "Phase 1: V2 data model — do not merge until production cutover".
4. The maintainer confirms in the Render dashboard that the service deploys only the `main` branch.

**Verification**
- CI runs on the draft PR and is green with no changes.
- A push to `phase-1` triggers CI on the PR and **no** Render deploy.

**Definition of done**
- [x] `phase-1` exists with a draft PR and green CI.
- [x] Render is confirmed to deploy only `main`.

---

## 7. Milestone 1 — V2 identity rules on the current schema

**Objective:** signup and login validate and normalize input with the V2 rules, so no request can reach the database with invalid identity data (fixes audit §4.7). Runs on the Phase 0 schema, whose columns already accept everything the rules allow.

**Rules** (from `docs/v2-design.md` §4; the 100-character email limit is confirmed in §14)
- **Username:** trimmed and lowercased, then must match `^[a-z0-9_]{3,32}$`. Stored lowercase; case-insensitive uniqueness comes from normalization.
- **Email:** trimmed and lowercased, a valid email address, at most 100 characters (the current column size).
- **Password:** required and non-empty. Password rules come in Phase 2.
- **Login:** the email is normalized the same way before the lookup.

**Files likely to change**
- `server/lib/limits.ts` (new): the shared limits.
- `server/http/schemas.ts` (new): zod schemas for the signup and login bodies, and a helper that turns a failed parse into `AppError(400, VALIDATION_ERROR, message, details)`, where `message` describes the first problem and `details` lists `{ field, message }` for all of them.
- `server/routes/auth.js`: use the schemas; the duplicate pre-check and the `23505` handling use the normalized values.
- `client/src/pages/Signup.jsx`: username `minLength` 3, `maxLength` 32, a hint ("3–32 letters, digits or underscores"); email `maxLength` 100.
- `server/test/auth.test.ts`, `server/test/errors.test.ts`.

**Tests**
- A username that is too short, too long or has invalid characters returns 400 `VALIDATION_ERROR` with `details`; a 51-character username returns 400 (audit §4.7), never 500.
- `Alice_1` signs up as `alice_1`; `alice_1` then gets 409 (case-insensitive uniqueness).
- `Alice@Example.test` signs up as `alice@example.test`, and logging in as `ALICE@example.test` works.
- An invalid or over-length email returns 400.
- Existing auth, error and race tests still pass (updated where the missing-fields message changes).

**Definition of done**
- [x] No signup or login input can produce a 500 from invalid identity data.
- [x] The signup form's constraints match the server rules.

---

## 8. Milestone 2 — V2 schema and `#general` cutover

**Objective:** `0002` replaces the Phase 0 tables with the V2 schema, and the single-room app runs on it through `#general`, with the same REST and socket contract (plus an additive `seq` field).

**Files likely to change**
- `server/migrations/0002_v2_schema.sql` (new, created with `npm run migrate:create -- v2_schema`)
- `server/repositories/` (new, TypeScript): `users.ts`, `conversations.ts`, `messages.ts` — the first part of the V2 repository layer (§3 of the design); no service or policy layer yet (Phase 3).
- `server/db/transaction.ts` (new): a small `withTransaction(fn)` helper around `pool.connect()`, `BEGIN`/`COMMIT`/`ROLLBACK` and `release()`.
- `server/routes/auth.js`, `server/routes/messages.js`, `server/socket/socketHandler.js`
- `server/test/setup.ts`, `auth.test.ts`, `messages.test.ts`, `socket.test.ts`, `schema.test.ts` (new)
- `CLAUDE.md` (schema notes)

**Migration `0002` — up**
1. `DROP TABLE messages; DROP TABLE users;` (Phase 0 tables; no data is kept, D6).
2. Create, exactly as `docs/v2-design.md` §4 specifies:
   - `users`: `id integer GENERATED ALWAYS AS IDENTITY` PK; `username` UNIQUE, CHECK `^[a-z0-9_]{3,32}$`; `email` UNIQUE, CHECK `email = lower(email)` and length ≤ 100; `display_name` CHECK length 1–50; `password_hash`; `created_at`, `updated_at timestamptz DEFAULT now()`.
   - `conversations`: `type` (`channel`/`dm`), `visibility` (`public`/`private`), `name` CHECK `^[a-z0-9-]{1,40}$`, `topic`, `created_by` FK → users ON DELETE SET NULL, `last_seq int NOT NULL DEFAULT 0`, `last_message_at`, timestamps; table CHECK: channels have `name` and `visibility`, DMs have neither; partial UNIQUE (`name`) WHERE `type = 'channel'`.
   - `direct_conversations`: `conversation_id` PK/FK ON DELETE CASCADE; `user_a_id`, `user_b_id` FK → users; CHECK `user_a_id < user_b_id`; UNIQUE (`user_a_id`, `user_b_id`).
   - `conversation_members`: PK (`conversation_id`, `user_id`), both FKs ON DELETE CASCADE; `role` CHECK in (`owner`, `admin`, `member`); `last_read_seq int NOT NULL DEFAULT 0`; `joined_at`; index (`user_id`, `conversation_id`).
   - `messages`: `conversation_id` FK ON DELETE CASCADE; `seq int NOT NULL`; `author_id` FK → users ON DELETE RESTRICT; `client_id uuid NOT NULL` (no default: callers must supply it); `content text NOT NULL`; `created_at`, `edited_at`, `deleted_at`; UNIQUE (`conversation_id`, `seq`); UNIQUE (`author_id`, `client_id`); CHECK `deleted_at IS NOT NULL OR char_length(content) BETWEEN 1 AND 4000`.
   - Not in `0002`: `sessions` (Phase 2), `rev`/`last_rev` and their index (added later, when edit and delete sync requires them; §14), the search index (later).
3. Seed `#general`: `INSERT INTO conversations (type, visibility, name) VALUES ('channel', 'public', 'general')`.

**Migration `0002` — down:** drop the V2 tables and recreate the Phase 0 `users` and `messages` tables exactly as in `0001`.

**App changes (contract unchanged, plus `seq`)**
- **Signup:** in one transaction, insert the user (`username` normalized, `display_name` = the trimmed username as typed, `password_hash`; the chat keeps showing the lowercase `username` for now, confirmed in §14) and a `member` row in `#general` with `last_read_seq` = `#general`'s current `last_seq`, so old history does not count as unread. The pre-check and `23505` → 409 stay. The JWT keeps its `{ id, username }` shape (auth changes in Phase 2).
- **Login:** reads `password_hash`.
- **History (`GET /api/messages`):** the last 50 messages of `#general` by `seq`, joined to `users` for `username`; returned oldest first in the existing shape, plus `seq`.
- **Send (`new_message`):** in one transaction, `UPDATE conversations SET last_seq = last_seq + 1, last_message_at = now() … RETURNING last_seq` (the row lock), then insert the message with that `seq` and a server-generated `client_id` (`gen_random_uuid()`). Broadcast after commit, in the existing shape plus `seq`. (The membership guard and the other design details follow in M3.)
- `#general` is looked up by name (`type = 'channel' AND name = 'general'`), never by a hard-coded id.

**Test harness**
- The per-test reset (in `test/setup.ts`) keeps the in-database `_test` guard, truncates all V2 tables with `RESTART IDENTITY CASCADE`, and re-seeds `#general` with the same statement as `0002`.
- Existing tests are updated to the new columns (`password_hash`, `author_id`, `seq`); their assertions on behavior stay the same.

**Tests (`schema.test.ts`, at the database level)**
- `users`: username pattern (rejects uppercase, too short, too long, invalid characters), lowercase email, email length, display name length, unique username and email.
- `conversations`: the channel/DM shape check, the name pattern, unique channel names (DMs have no name), `type`/`visibility` values.
- `direct_conversations`: `user_a_id < user_b_id` rejects self-DMs and reversed pairs; the unique pair.
- `conversation_members`: the role values; one row per user per conversation.
- `messages`: content 1–4000 unless `deleted_at` is set; unique `seq` per conversation; unique `client_id` per author; an author with messages cannot be deleted.

**Verification**
- On an empty database, `npm run migrate` applies `0001` and `0002`; `#general` exists exactly once as a public channel.
- `npm run migrate:down` restores the Phase 0 schema, and `npm run migrate` re-applies `0002`.
- All tests pass locally and in CI.
- Manually: signup, login, history and sending work in the browser; the message payloads include `seq`.

**Definition of done**
- [x] Local and CI databases are built by `0001` + `0002`.
- [x] The single-room app works on the V2 schema through `#general`.
- [x] Every constraint in `0002` is covered by a test.

---

## 9. Milestone 3 — Ordering guarantees

**Objective:** the send path is the full transaction from `docs/v2-design.md` §5, and the ordering properties are proven under concurrency.

**Files likely to change**
- `server/repositories/messages.ts`, `server/socket/socketHandler.js`, `server/lib/limits.ts`
- `server/test/ordering.test.ts` (new), `socket.test.ts`

**Steps**
1. **Membership guard:** insert the message with `INSERT … SELECT … WHERE EXISTS (membership)`. If no row is inserted (the sender is not a member, e.g. a token for a user that no longer exists), roll back — so `last_seq` is not consumed — and emit `error { message }` to the sender.
2. **Sender read position:** in the same transaction, `last_read_seq = GREATEST(last_read_seq, seq)` for the sender.
3. **Message length:** trimmed content must be 1–4000 characters (the shared limit). Empty stays silently ignored (current behavior); over 4000 emits `error { message: 'Message is too long (maximum 4000 characters).' }` instead of reaching the database constraint.

**Tests (`ordering.test.ts`)**
- 20 messages sent concurrently from two sockets get exactly `seq` 1–20, no gaps or duplicates, and `last_seq` = 20.
- A send that fails after the counter increment (non-member) leaves `last_seq` unchanged; the next successful message gets the next `seq`.
- History is ordered by `seq`, not by `created_at`.
- The sender's `last_read_seq` equals the `seq` of their latest message.
- A 4001-character message is rejected with the error event and nothing is stored.

**Definition of done**
- [x] Concurrent sends are gapless and ordered by `seq`, proven by tests.
- [x] A failed send never consumes a `seq`.

---

## 10. Milestone 4 — Phase 1 verification and handoff

**Objective:** Phase 1 is verified end to end, documented, and ready for either the production cutover or Phase 2.

**Files likely to change**
- `docs/adr/0001-fresh-database-and-migration-layout.md`, `0002-integer-identity-ids.md`, `0003-per-conversation-sequence.md` (new, short)
- `README.md`, `CLAUDE.md`, `docs/v2-design.md`, this plan

**Steps**
1. **ADRs** (the deferred Phase 0 item: "alongside the phase that implements each decision"): D6 and the `0002` layout; D10 integer identity IDs; per-conversation `seq` with the row-lock counter (the D5 groundwork; `rev` is added later, when edit and delete sync requires it).
2. **Docs:** CLAUDE.md (schema, `#general`, repositories, `seq`, the test reset), README (Phase 1 status: complete on `phase-1`, production still on Phase 0), `docs/v2-design.md` §9 (Phase 1 status).
3. **Fresh-clone verification:** follow the README from a fresh clone of `phase-1` and a clean Docker volume, as in Phase 0 Task 11.
4. **Completion record** in this plan, and the cutover runbook (§13) reviewed and ready.

**Definition of done**
- [x] Every item in §11 is checked.
- [ ] The maintainer decides when to run the production cutover (§13). *(Open: handed over in §16.)*

---

## 11. Final Phase 1 verification checklist

- [x] `phase-1` CI is green: lint, typecheck, tests and build for both projects. *(Every push to the draft PR; 124 server tests.)*
- [x] A fresh clone and clean Docker volume build `relay_dev` and `relay_test` from `0001` + `0002`; `#general` is seeded. *(M4: README followed from a fresh clone of `phase-1` at `e492dec`; `#general` exists once.)*
- [x] `0002` rolls back to the Phase 0 schema and re-applies cleanly. *(Scratch databases: a schema dump after `down` is identical to a `0001`-only database; also on the fresh clone's `relay_dev`.)*
- [x] Signup, login, history and sending work in the browser on the V2 schema. *(Headless Chrome with two users, in M2, M3 and on the fresh clone.)*
- [x] Invalid signup input returns 400, never 500 (audit §4.7). *(`auth.test.ts`, `errors.test.ts`; also a request without a JSON body.)*
- [x] Every constraint in `0002` has a test; concurrent sends are gapless; failed sends consume no `seq`. *(`schema.test.ts`, `ordering.test.ts`; both checked by breaking what they test.)*
- [x] Message payloads carry `seq`; the REST and socket shapes are otherwise unchanged. *(`{ id, seq, userId, username, content, createdAt }`, built by one function for both.)*
- [x] Production is still on Phase 0: nothing from `phase-1` merged to `main`, and the production database untouched. *(`main` = Phase 0 plus the approved Phase 0 fix `460af2b`; PR #1 is a draft; the production database was never connected to.)*
- [x] Nothing from §12 was implemented. *(No conversation endpoints, rooms, sessions, REST send, client use of `seq`, `rev`, read endpoint, editing or display names.)*

---

## 12. Out of scope for Phase 1

| Item | When |
|---|---|
| Creating channels and DMs, joining, leaving, members, roles in use, conversation endpoints and UI | Phase 3 |
| Socket.io rooms and targeted delivery | Phase 3 |
| Sessions table, cookie auth, password rules, rate limiting, helmet, TLS verification | Phase 2 |
| REST send endpoint with client-supplied `clientId`, pagination, `Chat.jsx` rewrite, client use of `seq` | Phase 4 |
| `rev`/`last_rev`, the change feed, catch-up on reconnect | When edit and delete sync requires them: the D5 decision point (Phase 5), ahead of editing and deletion (Phase 7) |
| Read endpoint, unread counts in the UI, presence, typing redesign | Phase 6 |
| Editing and deleting messages | Phase 7 |
| Showing display names in the chat, and editing them | A later phase (the chat shows lowercase usernames until then) |
| Production cutover | Separate decision after Phase 1 (§13) |

---

## 13. Production cutover runbook (prepared, not executed in Phase 1)

When the maintainer decides to move production to the V2 schema. Reviewed at the end of Phase 1 (2026-09-27): the steps below add the migration precondition, the deploy order, the draft-PR merge, a check of the seed, and a rollback.

**Before starting:** CI is green on PR #1, and any commit on `main` that `phase-1` lacks has been merged into `phase-1`. Keep the current Render values of `DATABASE_URL` and `JWT_SECRET` for the rollback. Existing accounts and messages are discarded (D6): users sign up again.

1. Create a **new, empty** Neon database and copy its **direct** (unpooled) connection string. Do not reuse the existing one without emptying it: it has the Phase 0 tables but no `pgmigrations` table, so `0001` would fail on it, and keeping it intact is what makes the rollback possible.
2. From an up-to-date checkout of `phase-1`: `cd server && DATABASE_URL='<direct Neon URL>' npm run migrate`. It applies `0001_initial` and `0002_v2_schema`. Check the seed, for example in Neon's SQL editor: `SELECT id, type, visibility, name FROM conversations` returns one row, the public channel `general`.
3. In Render, set `DATABASE_URL` to the new database and `JWT_SECRET` to a **new** random string (`openssl rand -hex 32`): user IDs restart at 1, so old tokens must not validate. Save without deploying if Render offers that; otherwise the Phase 0 code runs against the new database, and its requests fail, until step 4's deploy is live (a few minutes; the old database is not touched).
4. Mark PR #1 ready and merge it with a merge commit, which keeps the per-task history: `gh pr ready 1 && gh pr merge 1 --merge`. Render deploys `main` with the new variables; Vercel deploys the client.
5. Smoke test the live site: sign up with a mixed-case username (shown lowercase) and try an invalid one such as `bad-name` (400 with a message); log in; send messages from two browsers; reload to see the history. Browsers still holding an old token are logged out when their socket reconnects.
6. Update the status lines (README, `docs/v2-design.md`, CLAUDE.md, this plan) to say that production runs Phase 1, with the date.
7. Delete the old database once the new one is confirmed working.

**Rollback (any time before step 7):** revert the merge on `main` (`git revert -m 1 <merge commit>`, then push), and restore the old `DATABASE_URL` and `JWT_SECRET` in Render. The old database was never modified, so Phase 0 comes back as it was. To try the cutover again later, revert that revert first.

---

## 14. Decisions confirmed at approval

Confirmed by the maintainer on 2026-09-27 (all as recommended in the draft):

| # | Question | Decision |
|---|---|---|
| 1 | Email length limit | **100 characters**, the current column size. Milestone 1's validation therefore works on both the Phase 0 and the V2 schema. |
| 2 | `rev`/`last_rev` | **Added later**, when edit and delete sync requires them, as an additive migration initialized from `seq`. `0002` has no `rev`. |
| 3 | Additional conversations | **Phase 3.** Phase 1 uses the seeded `#general` as the working conversation; other channels and DMs exist only as tested schema. |
| 4 | Workflow | **Commit directly to `phase-1`.** The draft PR `phase-1 → main` runs CI; no separate pull request per milestone. |
| 5 | Vercel previews | **Left enabled.** Previews call the production API; Phase 1's client change is compatible with it. |
| 6 | Display names | **Lowercase usernames are shown in the chat temporarily.** Signup stores the typed name as `display_name`; showing it is left to a later phase. |

---

## 15. Completion record

Phase 1 was completed on 2026-09-27 on the `phase-1` branch. One task per commit, each checked locally (tests, lint, typecheck, build) before committing; every push to the draft PR #1 (`phase-1 → main`, not merged) had green CI. Each milestone started after the maintainer approved the previous one.

| Milestone | Commits | Notes and deviations from the plan |
|---|---|---|
| M0 — Branch and baseline | `b266a67` | GitHub cannot open a pull request between identical branches, so `phase-1` starts with an empty commit (approved by the maintainer). The maintainer confirmed that Render deploys only `main` and did not deploy the branch push. |
| M1 — V2 identity rules | `65ed025`, `d4506eb` | Also fixed: signup or login without a JSON body returned 500; now 400 `VALIDATION_ERROR`. A missing-fields error now names the first problem ("Username is required.") and lists all of them in `details`. The signup form enforces the lengths and shows the character rule as a hint; the server enforces it (no `pattern` attribute, as planned). |
| M2 — V2 schema and `#general` | `658750c`, `78f8c96`, `7cb5f04` | `migrate:create` produced `0002_v2-schema.sql`; renamed to the planned `0002_v2_schema.sql`. All constraints are named, and columns the design implies are required are `NOT NULL`. `conversations_shape` is written so that `conversations_type_values` is the constraint that rejects an unknown type (Postgres checks CHECK constraints in name order). `http/schemas.ts` also returns the username as typed, for `display_name`. The CLAUDE.md project status was corrected. The schema tests were checked by dropping constraints; that check changed the NOT NULL test to an explicit column list. |
| M3 — Ordering guarantees | `ede2984`, `1a04cf4`, `eec53ec` | The message limit counts characters (code points) like the constraint's `char_length()`, so 4000 emoji are accepted. Checked by breaking each part (no rollback, `max(seq)+1` instead of the row lock, no read position, counting UTF-16 units): each break fails its test. |
| M4 — Verification and handoff | `83da1fe`, `e492dec`, *(this change)* | ADRs 0001–0003 in `docs/adr/`. README, `docs/v2-design.md` and CLAUDE.md updated. The cutover runbook (§13) was reviewed and extended. |
| Phase 0 fix on `main` | `460af2b`, merged in `f277f8e` | Found while preparing M3: `socket.emit('new_message', null)` from any logged-in client crashed the server with an unhandled rejection, in production too. Fixed on `main` with a regression test, following §4 (approved by the maintainer). CI was green and Vercel deployed it; Render deploys `main` automatically, but GitHub cannot show Render deploys, so the maintainer confirms that one in the Render dashboard. Then merged into `phase-1`. |

**Verification (M4)**
- **Fresh clone:** `phase-1` at `e492dec`, cloned from GitHub, with a clean Docker volume, following the README: install, `docker compose up -d --wait`, `.env` from `.env.example`, `npm run migrate` (`0001` + `0002`; `#general` once), `npm run dev` for both projects. In headless Chrome, two users signed up and sent messages both ways (socket payloads with `seq` 1 and 2), the page was reloaded (history by `seq`), the user logged out and back in with the email in another case, and an invalid username showed the server's 400 message. `npm test`: 124/124; lint, typecheck and build clean in both projects; `relay_test` built from `0001` + `0002`.
- **Rollback:** `0002` down restores the Phase 0 tables and up re-applies, on scratch databases (schema dump identical to a `0001`-only database) and on the fresh clone's `relay_dev`.
- **Production:** `main` contains no Phase 1 code (only migration `0001`; its one commit since the plan is the Phase 0 fix above). Vercel built only previews of `phase-1`. The production database was never connected to.

**Final state:** 124 server tests in 9 files (auth, errors, messages, socket, ordering, schema, env, logger, pool). Lint, typecheck and build clean in both projects. No dependencies were added in Phase 1.

**Known issues carried forward**
- **Composer clears before the server answers:** a message the server rejects (over 4000 characters, or a failed save) shows an error toast, but its text is already gone from the composer. Pending, failed and retry states come in Phase 4.
- **Read position moves only on send:** there is no read endpoint until Phase 6, so `last_read_seq` is the member's join position or their latest own message.
- **Display names are stored, not shown:** the chat shows lowercase usernames (§14, decision 6).
- **Socket payloads are checked by hand, not by zod:** D17 calls for schema validation of socket payloads; `new_message` is replaced by the REST send endpoint in Phase 4, which gets a zod schema.
- **Dependency advisories:** `npm audit` reports 6 in the server (1 low, 1 moderate, 4 high; transitive, through socket.io and express, as in Phase 0) and 13 in the client (1 low, 2 moderate, 10 high; for example `engine.io-client`); fixes are available. Not addressed in Phase 1.
- **CI runner image:** GitHub warns that `ubuntu-latest` moves to Ubuntu 26 from 2026-10-19.
- **Local dev:** killing the process on port 5001 leaves `tsx watch` running (it waits for file changes); stop the dev server with Ctrl-C.
- From Phase 0, unchanged: the intermittent 520 from Render's proxy after idle; client ESLint only lints `.js`/`.jsx`; pino-http logs 4xx/5xx request lines at `info`; Ctrl-C twice force-kills the dev server. The one-off test failure seen in Phase 0 did not recur.

---

## 16. Handoff to the cutover and Phase 2

**Starting point:** `phase-1` as recorded in §15: the V2 schema from `docs/v2-design.md` §4 (without `sessions` and `rev`), and the single-room app running on `#general` with gapless per-conversation `seq`. Production still runs Phase 0 from `main`.

**Decisions for the maintainer**
1. **When to run the production cutover (§13):** before Phase 2 starts, or later. Until then, Phase 0 fixes go to `main` and `main` is merged into `phase-1`.
2. **Where Phase 2 is developed:** on `phase-1` if the cutover has not happened (production must not receive Phase 2 before the cookie topology is chosen), or on a new branch from `main` after it.
3. **The production cookie topology** (`docs/v2-design.md` §6) must be chosen before Phase 2 is deployed to production.

**First step of Phase 2:** write `docs/phase-2-implementation-plan.md` in the same format as this plan, and get it approved before any Phase 2 code.

**Notes for later phases**
- **Phase 2:** the `sessions` table and password rules; the JWT (`{ id, username }`) is still issued by `routes/auth.js` and verified in two places.
- **Phase 3:** new members join through `addMember()`, which starts their read position at `last_seq`. Removing a member must take the conversation's row lock, so a removal and a send are strictly ordered (ADR 0003).
- **Phase 4:** the client starts using `seq`, the client supplies `client_id` (`UNIQUE (author_id, client_id)` makes retries idempotent), and the composer gets pending and failed states.
- **Phase 5:** the D5 decision point; `rev`/`last_rev` are added, initialized from `seq`, if the full model is chosen (§14, decision 2).

