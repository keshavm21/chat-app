// server/lib/limits.ts
// Limits shared by the code and the tests. Those the database enforces as well are
// repeated in SQL by the migrations, so a change to one of them needs a matching migration.

/** A stored username: 3–32 lowercase letters, digits or underscores (input is lowercased first). */
export const USERNAME_PATTERN = /^[a-z0-9_]{3,32}$/;

/** Maximum length of a stored email address (stored lowercase). */
export const EMAIL_MAX_LENGTH = 100;

/** Minimum length of a new password, in characters (code points). Login accepts any length. */
export const PASSWORD_MIN_LENGTH = 8;

/** Maximum length of a new password in UTF-8 bytes: bcrypt ignores everything after 72. */
export const PASSWORD_MAX_BYTES = 72;

/**
 * Maximum length of a message after trimming, in characters (code points, as the
 * database's char_length() counts them).
 */
export const MESSAGE_MAX_LENGTH = 4000;

/** Maximum length of a session's stored user agent, in characters; longer ones are cut. */
export const USER_AGENT_MAX_LENGTH = 512;

/** A channel name: 1–40 lowercase letters, digits or hyphens (input is lowercased first). */
export const CHANNEL_NAME_PATTERN = /^[a-z0-9-]{1,40}$/;

/** Maximum length of a channel's topic after trimming, in characters (code points). Not enforced by the database. */
export const CHANNEL_TOPIC_MAX_LENGTH = 250;

/** Maximum length of a search prefix (`?q=` of GET /api/channels and GET /api/users), after trimming. */
export const SEARCH_MAX_LENGTH = 100;

/** How many public channels GET /api/channels lists at most. */
export const CHANNEL_LIST_LIMIT = 50;

/** How many users GET /api/users finds at most. */
export const USER_SEARCH_LIMIT = 10;

/** Messages per history page (GET /api/conversations/:id/messages) by default, and at most. */
export const MESSAGE_PAGE_SIZE = 50;
export const MESSAGE_PAGE_MAX = 100;

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** A session ends this long after login however active it is (sessions.expires_at); also the cookie's Max-Age. */
export const SESSION_MAX_AGE_MS = 30 * DAY_MS;

/** A session also ends after this long without use (sessions.last_seen_at). */
export const SESSION_IDLE_TIMEOUT_MS = 7 * DAY_MS;

/** last_seen_at is moved forward at most this often, so most requests write nothing. */
export const SESSION_TOUCH_INTERVAL_MS = HOUR_MS;

/** How often the session sweep disconnects sockets of ended sessions and deletes their rows. */
export const SESSION_SWEEP_INTERVAL_MS = 5 * MINUTE_MS;

/** A rate limit: at most `limit` counted requests per key in any `windowMs`. */
export interface RateLimit {
  limit: number;
  windowMs: number;
}

/**
 * The rate limits (docs/phase-2-implementation-plan.md §10, §16; docs/phase-3-implementation-plan.md §5);
 * createApp's default.
 */
export const RATE_LIMITS: {
  readonly login: RateLimit;
  readonly signup: RateLimit;
  readonly userSearch: RateLimit;
  readonly channelCreation: RateLimit;
} = Object.freeze({
  /** Failed logins per IP and email; successful ones do not count. */
  login: Object.freeze({ limit: 10, windowMs: 15 * MINUTE_MS }),
  /** Signup attempts per IP, whatever their outcome. */
  signup: Object.freeze({ limit: 20, windowMs: HOUR_MS }),
  /** User searches (GET /api/users) per user and IP: enough to search as you type. */
  userSearch: Object.freeze({ limit: 60, windowMs: MINUTE_MS }),
  /**
   * Channels created per user (only successful creations count), so one account cannot
   * flood the channel list. The demo account's visitors share it, so it is not tiny.
   */
  channelCreation: Object.freeze({ limit: 20, windowMs: HOUR_MS }),
});
