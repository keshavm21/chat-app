// server/http/schemas.ts
// Request body and query schemas. Routes call `schema.safeParse(req.body)` (or
// `req.query`) and, on failure, `next(validationError(result.error))`.
import { z } from 'zod';
import { AppError, ErrorCode } from '../lib/errors.js';
import { MAX_ID } from '../lib/ids.js';
import {
  CHANNEL_NAME_PATTERN,
  CHANNEL_TOPIC_MAX_LENGTH,
  EMAIL_MAX_LENGTH,
  MESSAGE_PAGE_MAX,
  PASSWORD_MAX_BYTES,
  PASSWORD_MIN_LENGTH,
  SEARCH_MAX_LENGTH,
  USERNAME_PATTERN,
} from '../lib/limits.js';

const body = { error: 'Request body must be a JSON object.' };

// Emails are compared and stored trimmed and lowercased.
const email = z.string({ error: 'Email is required.' }).trim().toLowerCase();
const password = z.string({ error: 'Password is required.' }).min(1, 'Password is required.');

// A new password (signup only; login keeps `password`, so older, shorter passwords still
// work). Rejected rather than cut when over bcrypt's 72 bytes, which it would silently
// ignore. The checks exclude each other, so a password gets at most one message.
const newPassword = password
  .refine(
    (value) => value === '' || [...value].length >= PASSWORD_MIN_LENGTH,
    `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`,
  )
  .refine(
    (value) => Buffer.byteLength(value, 'utf8') <= PASSWORD_MAX_BYTES,
    `Password must be at most ${PASSWORD_MAX_BYTES} bytes; accented letters and emoji take 2–4 bytes each.`,
  );

export const signupSchema = z
  .object(
    {
      username: z
        .string({ error: 'Username is required.' })
        .trim()
        .refine(
          (typed) => USERNAME_PATTERN.test(typed.toLowerCase()),
          'Username must be 3–32 characters: letters, digits or underscores.',
        ),
      email: email.pipe(
        z
          .email('Email must be a valid email address.')
          .max(EMAIL_MAX_LENGTH, `Email must be at most ${EMAIL_MAX_LENGTH} characters.`),
      ),
      password: newPassword,
    },
    body,
  )
  // The username is stored lowercase; the display name keeps it as typed.
  .transform(({ username, ...rest }) => ({ ...rest, username: username.toLowerCase(), displayName: username }));

// Login only normalizes the email: an address that could never have signed up
// simply matches no user.
export const loginSchema = z.object(
  {
    email: email.min(1, 'Email is required.'),
    password,
  },
  body,
);

// A new channel. Its name is stored lowercase, like usernames; a blank topic is none.
export const createChannelSchema = z.object(
  {
    name: z
      .string({ error: 'Channel name is required.' })
      .trim()
      .toLowerCase()
      .regex(CHANNEL_NAME_PATTERN, 'Channel name must be 1–40 characters: letters, digits or hyphens.'),
    topic: z
      .string({ error: 'Topic must be text.' })
      .trim()
      .refine(
        (topic) => [...topic].length <= CHANNEL_TOPIC_MAX_LENGTH,
        `Topic must be at most ${CHANNEL_TOPIC_MAX_LENGTH} characters.`,
      )
      // Postgres text cannot hold U+0000: it would fail the insert (a 500).
      .refine((topic) => !topic.includes('\u0000'), 'Topic must not contain NUL characters.')
      .nullish()
      .transform((topic) => topic || null),
    visibility: z.enum(['public', 'private'], { error: 'Visibility must be public or private.' }).default('public'),
  },
  body,
);

// The user to open a DM with.
export const createDmSchema = z.object(
  {
    userId: z
      .int({ error: 'userId must be a user id.' })
      .min(1, 'userId must be a user id.')
      .max(MAX_ID, 'userId must be a user id.'),
  },
  body,
);

// A new member of a private channel, by username (stored lowercase).
export const addMemberSchema = z.object(
  {
    username: z
      .string({ error: 'Username is required.' })
      .trim()
      .toLowerCase()
      .min(1, 'Username is required.')
      .regex(USERNAME_PATTERN, 'Username must be 3–32 characters: letters, digits or underscores.'),
  },
  body,
);

// The seq of the latest message I have read (0: none).
export const markReadSchema = z.object(
  {
    seq: z
      .int({ error: 'seq must be a whole number.' })
      .min(0, 'seq must be a whole number.')
      .max(MAX_ID, 'seq must be a whole number.'),
  },
  body,
);

// `?q=`: a name prefix, trimmed and lowercased like the names it is compared with ('' matches
// every name). Only characters that channel names and usernames can contain: anything
// else could match nothing (and U+0000 would fail the query). Express parses a repeated
// `q` into an array, which is refused.
export const searchQuerySchema = z.object({
  q: z
    .string({ error: 'q must be a single string.' })
    .trim()
    .toLowerCase()
    .max(SEARCH_MAX_LENGTH, `q must be at most ${SEARCH_MAX_LENGTH} characters.`)
    .regex(/^[a-z0-9_-]*$/, 'q may only contain letters, digits, hyphens and underscores.')
    .default(''),
});

// A whole number from a query string, within [min, max].
const queryNumber = (field: string, min: number, max: number) =>
  z.coerce
    .number({ error: `${field} must be a whole number.` })
    .int(`${field} must be a whole number.`)
    .min(min, `${field} must be at least ${min}.`)
    .max(max, `${field} must be at most ${max}.`);

// A page of history: the latest `limit` messages before seq `before` (both optional).
export const messagesQuerySchema = z.object({
  before: queryNumber('before', 1, MAX_ID).optional(),
  limit: queryNumber('limit', 1, MESSAGE_PAGE_MAX).optional(),
});

/**
 * A failed parse as a 400 VALIDATION_ERROR: `message` describes the first problem and
 * `details` lists `{ field, message }` for all of them (`field` is '' for the body itself).
 */
export function validationError(error: z.ZodError): AppError {
  const details = error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message }));
  return new AppError(400, ErrorCode.VALIDATION_ERROR, details[0].message, details);
}
