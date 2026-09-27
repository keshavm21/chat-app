# ADR 0002: Integer identity IDs

- **Status:** Accepted (2026-09-27). Implemented in Phase 1 by migration `0002_v2_schema`.
- **Decision record:** D10 in `docs/v2-design.md` §10.

## Context

Every V2 table needs a primary key, and the IDs travel to the client in REST and socket payloads. The choice affects the database, the JSON contract and how the client compares IDs. Relay runs as a single instance against one Postgres database (D16), at chat-demo scale.

## Decision

- Primary keys are **`integer GENERATED ALWAYS AS IDENTITY`** (int4) on `users`, `conversations` and `messages`. Link tables use their foreign keys as the key (`direct_conversations.conversation_id`, `conversation_members (conversation_id, user_id)`).
- `GENERATED ALWAYS` rather than `SERIAL` or `BY DEFAULT`: it is standard SQL, the sequence belongs to the column, and an insert that supplies its own `id` is rejected instead of silently colliding with the sequence later.
- UUIDs are used only where a value must be created outside the database: `messages.client_id`, the idempotency key for sends. Today the server generates it (`gen_random_uuid()`); from Phase 4 the client supplies it.

## Alternatives considered

- **`bigint` identity.** The ceiling (about 9.2 × 10¹⁸) is irrelevant at this scale, and node-postgres returns `bigint` as a JavaScript string, so every ID in the API would become a string or need custom parsing.
- **UUID primary keys.** Unguessable and generable anywhere, but 16 bytes in every index and foreign key, harder to read in logs and tests, and not needed: nothing else creates IDs, and unguessability is not what protects data (see below).

## Consequences

- IDs arrive in JavaScript as plain numbers, in both the REST and socket payloads.
- About 2.1 billion rows per table. Changing a column to `bigint` later is a known migration if that is ever approached.
- IDs are sequential and guessable. Authorization must never rely on an ID being secret: from Phase 3, every conversation route checks membership and answers 404 to non-members (`docs/v2-design.md` §6).
- User IDs restart at 1 in a fresh database, which is why the production cutover rotates `JWT_SECRET` (ADR 0001).
- Tests reset identities with `TRUNCATE … RESTART IDENTITY`, so IDs are predictable within a test.
