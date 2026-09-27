// server/lib/limits.ts
// Limits shared by the code and the tests. Those the database enforces as well are
// repeated in SQL by the migrations, so a change to one of them needs a matching migration.

/** A stored username: 3–32 lowercase letters, digits or underscores (input is lowercased first). */
export const USERNAME_PATTERN = /^[a-z0-9_]{3,32}$/;

/** Maximum length of a stored email address (stored lowercase). */
export const EMAIL_MAX_LENGTH = 100;

/**
 * Maximum length of a message after trimming, in characters (code points, as the
 * database's char_length() counts them).
 */
export const MESSAGE_MAX_LENGTH = 4000;

/** Maximum length of a session's stored user agent, in characters; longer ones are cut. */
export const USER_AGENT_MAX_LENGTH = 512;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** A session ends this long after login however active it is (sessions.expires_at); also the cookie's Max-Age. */
export const SESSION_MAX_AGE_MS = 30 * DAY_MS;

/** A session also ends after this long without use (sessions.last_seen_at). */
export const SESSION_IDLE_TIMEOUT_MS = 7 * DAY_MS;

/** last_seen_at is moved forward at most this often, so most requests write nothing. */
export const SESSION_TOUCH_INTERVAL_MS = HOUR_MS;

/** How often the session sweep disconnects sockets of ended sessions and deletes their rows. */
export const SESSION_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
