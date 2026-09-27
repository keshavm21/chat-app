// server/http/schemas.ts
// Request body schemas. Routes call `schema.safeParse(req.body)` and, on failure,
// `next(validationError(result.error))`.
import { z } from 'zod';
import { AppError, ErrorCode } from '../lib/errors.js';
import { EMAIL_MAX_LENGTH, USERNAME_PATTERN } from '../lib/limits.js';

const body = { error: 'Request body must be a JSON object.' };

// Emails are compared and stored trimmed and lowercased.
const email = z.string({ error: 'Email is required.' }).trim().toLowerCase();
const password = z.string({ error: 'Password is required.' }).min(1, 'Password is required.');

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
      password,
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

/**
 * A failed parse as a 400 VALIDATION_ERROR: `message` describes the first problem and
 * `details` lists `{ field, message }` for all of them (`field` is '' for the body itself).
 */
export function validationError(error: z.ZodError): AppError {
  const details = error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message }));
  return new AppError(400, ErrorCode.VALIDATION_ERROR, details[0].message, details);
}
