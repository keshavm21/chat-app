-- Phase 3: channel names are unique among public channels only (docs/phase-3-implementation-plan.md §10).
-- With one index over every channel, creating a channel named like a private one failed with a
-- conflict, which told anyone that the private channel existed. Private channels may now share
-- a name with each other or with a public channel; only their members ever see them.

-- Up Migration

DROP INDEX conversations_channel_name_key;
CREATE UNIQUE INDEX conversations_public_channel_name_key ON conversations (name)
  WHERE type = 'channel' AND visibility = 'public';

-- Down Migration

-- Fails if two channels share a name, as private ones now may.
DROP INDEX conversations_public_channel_name_key;
CREATE UNIQUE INDEX conversations_channel_name_key ON conversations (name) WHERE type = 'channel';
