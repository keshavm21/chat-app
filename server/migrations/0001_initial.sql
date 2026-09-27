-- Phase 0 baseline: the current single-room schema, exactly as defined in
-- README.md ("Create the database") and used by the existing code.
-- Temporary: Phase 1 replaces these tables with the V2 schema.

-- Up Migration

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

-- Down Migration

DROP TABLE messages;
DROP TABLE users;
