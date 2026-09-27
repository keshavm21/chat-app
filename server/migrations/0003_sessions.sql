-- Phase 2: server-side sessions (docs/v2-design.md §4 and §6, D3).
-- Only adds a table, which the Phase 1 app ignores, so it can be applied before the release.
-- The session token itself is never stored: token_hash is its SHA-256.
-- Limits repeat server/lib/limits.ts; test/schema.test.ts checks that both agree.

-- Up Migration

CREATE TABLE sessions (
  token_hash   bytea       PRIMARY KEY,
  user_id      integer     NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  user_agent   text,
  CONSTRAINT sessions_token_hash_length CHECK (octet_length(token_hash) = 32),
  CONSTRAINT sessions_user_agent_length CHECK (char_length(user_agent) <= 512)
);

CREATE INDEX sessions_user_id_idx ON sessions (user_id);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

-- Down Migration

DROP TABLE sessions;
