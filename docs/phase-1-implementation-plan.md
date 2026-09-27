# Relay — Phase 1 Implementation Plan

**Status:** ✅ **Approved** (2026-09-27). The maintainer's decisions on the open questions are recorded in [§14](#14-decisions-confirmed-at-approval). Work starts with Milestone 0.
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

- [ ] **All Phase 1 commits go to the `phase-1` branch, never to `main`.** A draft pull request `phase-1 → main` (marked "do not merge until the production cutover") makes CI run on every push to the branch.
- [ ] Commit directly to `phase-1`; the draft PR is the only pull request and exists to run CI (no per-milestone PRs). One task per commit, lint/typecheck/tests before each commit. A milestone is done when CI is green on the branch and its verification and definition of done are met; the next milestone starts only after the maintainer approves.
- [ ] Phase 0 fixes still go to `main` (production), and `main` is merged into `phase-1` afterwards so the branch doesn't drift.
- [ ] Never connect to or modify the production database. `0002` runs only against `relay_dev`, `relay_test`, CI's database and scratch databases.
- [ ] Tests only run against a local `*_test` database (the Phase 0 guard stays in place).
- [ ] Vercel builds preview deployments of branch pushes, and those previews call the **production** API. Phase 1 client changes (Milestone 1's signup form) are compatible with the Phase 0 API, so this is harmless, so previews stay enabled (confirmed, §14).
- [ ] Limits used by both validation and the database (username pattern, email length, message length) live in one module (`server/lib/limits.ts`); the migration repeats them in SQL, and tests check that both agree.

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
- [ ] `phase-1` exists with a draft PR and green CI.
- [ ] Render is confirmed to deploy only `main`.

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
- [ ] No signup or login input can produce a 500 from invalid identity data.
- [ ] The signup form's constraints match the server rules.

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
- [ ] Local and CI databases are built by `0001` + `0002`.
- [ ] The single-room app works on the V2 schema through `#general`.
- [ ] Every constraint in `0002` is covered by a test.

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
- [ ] Concurrent sends are gapless and ordered by `seq`, proven by tests.
- [ ] A failed send never consumes a `seq`.

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
- [ ] Every item in §11 is checked.
- [ ] The maintainer decides when to run the production cutover (§13).

---

## 11. Final Phase 1 verification checklist

- [ ] `phase-1` CI is green: lint, typecheck, tests and build for both projects.
- [ ] A fresh clone and clean Docker volume build `relay_dev` and `relay_test` from `0001` + `0002`; `#general` is seeded.
- [ ] `0002` rolls back to the Phase 0 schema and re-applies cleanly.
- [ ] Signup, login, history and sending work in the browser on the V2 schema.
- [ ] Invalid signup input returns 400, never 500 (audit §4.7).
- [ ] Every constraint in `0002` has a test; concurrent sends are gapless; failed sends consume no `seq`.
- [ ] Message payloads carry `seq`; the REST and socket shapes are otherwise unchanged.
- [ ] Production is still on Phase 0: nothing from `phase-1` merged to `main`, and the production database untouched.
- [ ] Nothing from §12 was implemented.

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

When the maintainer decides to move production to the V2 schema:

1. Create a fresh, empty Neon database (or reset the existing one). Existing accounts and messages are discarded (D6).
2. From a checkout of the code being deployed: `cd server && DATABASE_URL='<direct Neon URL>' npm run migrate` (applies `0001` and `0002`, seeds `#general`).
3. In Render: set `DATABASE_URL` to the new database and set a **new** `JWT_SECRET` (user IDs restart at 1, so old tokens must not validate).
4. Merge `phase-1` into `main`; Render deploys it.
5. Smoke test on the live site: sign up, log in, send a message, reload to see it in history.
6. Delete the old database once the new one is confirmed working.

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
