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
