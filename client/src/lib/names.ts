// client/src/lib/names.ts
// Turning what people type into what the server accepts (server/http/schemas.ts).
// Framework-free, so client/test/names.test.js can run it under `node --test`.

/**
 * A search box's text as the `?q=` prefix of GET /api/channels or /api/users: without a
 * leading # or @, trimmed and lowercased. null when no channel name or username could
 * start with it (the server would answer 400), so there is nothing to ask.
 */
export function searchPrefix(input: string): string | null {
  const prefix = input.trim().replace(/^[#@]/, '').toLowerCase();
  return /^[a-z0-9_-]{0,100}$/.test(prefix) ? prefix : null;
}

/**
 * A new channel's name as it is typed: lowercase, spaces become hyphens, anything else a
 * channel name cannot hold is dropped, at most 40 characters (CHANNEL_NAME_PATTERN).
 */
export function toChannelName(input: string): string {
  return input.toLowerCase().replace(/^#/, '').replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 40);
}
