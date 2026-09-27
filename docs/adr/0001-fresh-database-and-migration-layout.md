# ADR 0001: Fresh database and the `0002` migration layout

- **Status:** Accepted (2026-09-27). Implemented in Phase 1 on the `phase-1` branch; reaches production at the cutover.
- **Decision record:** D6 in `docs/v2-design.md` §10; `docs/phase-1-implementation-plan.md` §2, decisions 1–3.

## Context

V2 replaces the single-room schema (`users` with a `password` column, `messages` with a copied `username`) with channels, DMs, memberships and per-conversation ordering. The existing production data is a small demo: a few accounts and messages. Phase 0 added node-pg-migrate with `0001_initial`, which reproduces the old schema so the old code and its tests had something to run against. `0001` has already run in every environment. The production database predates migrations, so it has the old tables but no `pgmigrations` table.

## Decision

- **Existing data is not preserved (D6).** V2 starts from an empty database, with no backfill and no compatibility constraints on the new schema.
- **`0001` is never edited.** Migration `0002_v2_schema` drops the Phase 0 tables and creates the V2 schema in one migration. node-pg-migrate runs migrations inside a transaction, so `0002` applies completely or not at all.
- **`0002` seeds the public `#general` channel.** The single-room app reads and writes it through the new tables, looked up by name, until conversation endpoints and UI arrive (Phases 3–4).
- **`0002`'s down migration restores the Phase 0 tables exactly as `0001` created them.** `migrate:down` keeps working, and a schema dump after `down` is identical to one of a database that only ran `0001`.
- **Production moves by a prepared cutover, not by migrating the old database:** a new empty database built by `0001` + `0002`, a rotated `JWT_SECRET` (user IDs restart at 1, so old tokens must not match new users), then the merge to `main` (`docs/phase-1-implementation-plan.md` §13).

## Alternatives considered

- **Rewrite `0001` as the V2 schema.** Simpler history, but `0001` is already recorded as applied in every database, so they would have to be rebuilt by hand, and the migration history would no longer describe what actually ran.
- **Migrate the data in place.** Needs a backfill of usernames, a `#general` membership for every user, and `seq` for every old message. That is real work and risk for demo data nobody needs.
- **Several smaller migrations (one per table).** The old code cannot run against a half-built V2 schema, so there is no useful state between them; one atomic migration is easier to reason about.

## Consequences

- Every production account and message is discarded at the cutover. Users sign up again.
- Local databases can be reset at any time (`docker compose down -v`), and tests truncate every V2 table and re-seed `#general` before each test.
- Production cannot receive Phase 1 until the cutover, so Phase 1 is developed on the long-lived `phase-1` branch; Phase 0 fixes still go to `main` and are merged into `phase-1`.
- A migration's down section is kept exact, which the scratch-database check (up, down, dump comparison, up again) verified for `0002`.
