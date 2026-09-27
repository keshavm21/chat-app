// server/lib/limits.ts
// Limits enforced both by request validation and by the database. Migrations repeat
// them in SQL, so a change here needs a matching migration.

/** A stored username: 3–32 lowercase letters, digits or underscores (input is lowercased first). */
export const USERNAME_PATTERN = /^[a-z0-9_]{3,32}$/;

/** Maximum length of a stored email address (stored lowercase). */
export const EMAIL_MAX_LENGTH = 100;
