-- Phase 1: the V2 data model (docs/v2-design.md §4) on a fresh database (D6).
-- Drops the Phase 0 tables (no data is kept) and seeds the public #general channel.
-- Limits repeat server/lib/limits.ts; test/schema.test.ts checks that both agree.
-- Not here yet: sessions (Phase 2), rev/last_rev (with edit and delete sync), search.

-- Up Migration

DROP TABLE messages;
DROP TABLE users;

CREATE TABLE users (
  id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username      text        NOT NULL,
  email         text        NOT NULL,
  display_name  text        NOT NULL,
  password_hash text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_username_key        UNIQUE (username),
  CONSTRAINT users_email_key           UNIQUE (email),
  CONSTRAINT users_username_format     CHECK (username ~ '^[a-z0-9_]{3,32}$'),
  CONSTRAINT users_email_lowercase     CHECK (email = lower(email)),
  CONSTRAINT users_email_length        CHECK (char_length(email) <= 100),
  CONSTRAINT users_display_name_length CHECK (char_length(display_name) BETWEEN 1 AND 50)
);

CREATE TABLE conversations (
  id              integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type            text        NOT NULL,
  visibility      text,
  name            text,
  topic           text,
  created_by      integer     REFERENCES users (id) ON DELETE SET NULL,
  last_seq        integer     NOT NULL DEFAULT 0,
  last_message_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversations_type_values       CHECK (type IN ('channel', 'dm')),
  CONSTRAINT conversations_visibility_values CHECK (visibility IN ('public', 'private')),
  CONSTRAINT conversations_name_format       CHECK (name ~ '^[a-z0-9-]{1,40}$'),
  -- Channels have a name and a visibility; DMs have neither. (Allowed types are
  -- conversations_type_values' job, so each constraint reports its own violation.)
  CONSTRAINT conversations_shape CHECK (
    CASE WHEN type = 'channel' THEN name IS NOT NULL AND visibility IS NOT NULL
         ELSE name IS NULL AND visibility IS NULL
    END
  )
);

CREATE UNIQUE INDEX conversations_channel_name_key ON conversations (name) WHERE type = 'channel';

CREATE TABLE direct_conversations (
  conversation_id integer PRIMARY KEY REFERENCES conversations (id) ON DELETE CASCADE,
  user_a_id       integer NOT NULL REFERENCES users (id),
  user_b_id       integer NOT NULL REFERENCES users (id),
  -- One order per pair, which also rules out a DM with oneself.
  CONSTRAINT direct_conversations_ordered_pair CHECK (user_a_id < user_b_id),
  CONSTRAINT direct_conversations_pair_key     UNIQUE (user_a_id, user_b_id)
);

CREATE TABLE conversation_members (
  conversation_id integer     NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  user_id         integer     NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role            text        NOT NULL,
  last_read_seq   integer     NOT NULL DEFAULT 0,
  joined_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id),
  CONSTRAINT conversation_members_role_values CHECK (role IN ('owner', 'admin', 'member'))
);

CREATE INDEX conversation_members_user_id_conversation_id_idx ON conversation_members (user_id, conversation_id);

CREATE TABLE messages (
  id              integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id integer     NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  seq             integer     NOT NULL,
  author_id       integer     NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  client_id       uuid        NOT NULL, -- no default: callers supply it
  content         text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  edited_at       timestamptz,
  deleted_at      timestamptz,
  CONSTRAINT messages_conversation_seq_key UNIQUE (conversation_id, seq),
  CONSTRAINT messages_author_client_id_key UNIQUE (author_id, client_id),
  -- A deleted message keeps its row (and seq) with the content cleared.
  CONSTRAINT messages_content_length CHECK (deleted_at IS NOT NULL OR char_length(content) BETWEEN 1 AND 4000)
);

INSERT INTO conversations (type, visibility, name) VALUES ('channel', 'public', 'general');

-- Down Migration

DROP TABLE messages;
DROP TABLE conversation_members;
DROP TABLE direct_conversations;
DROP TABLE conversations;
DROP TABLE users;

-- The Phase 0 tables, exactly as in 0001_initial.
CREATE TABLE users (
  id         SERIAL PRIMARY KEY,
  username   VARCHAR(50)  NOT NULL UNIQUE,
  email      VARCHAR(100) NOT NULL UNIQUE,
  password   VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE messages (
  id         SERIAL PRIMARY KEY,
  user_id    INT REFERENCES users(id),
  username   VARCHAR(50),
  content    TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);
