import express from 'express';
import bcrypt from 'bcrypt';
import pool from '../db/connection.js';
import { withTransaction } from '../db/transaction.js';
import { AppError, ErrorCode } from '../lib/errors.js';
import { loginSchema, signupSchema, validationError } from '../http/schemas.js';
import { requireSession } from '../http/requireSession.js';
import { logger } from '../lib/logger.js';
import { createSessionToken, hashSessionToken, sessionCookie } from '../lib/sessions.js';
import { createUser, findUserByEmail, isEmailOrUsernameTaken } from '../repositories/users.js';
import { addMember, findGeneralId } from '../repositories/conversations.js';
import { createSession, deleteSession } from '../repositories/sessions.js';

const router = express.Router();
const SALT_ROUNDS = 10;
const PG_UNIQUE_VIOLATION = '23505';

// Every signup and login starts a new session: a session cookie the request already
// carries is never reused, so a cookie planted by someone else cannot become a
// logged-in session. Returns the token for the cookie; the database gets its hash.
async function startSession(db, req, userId) {
  const token = createSessionToken();
  await createSession(db, { tokenHash: hashSessionToken(token), userId, userAgent: req.get('user-agent') });
  return token;
}

// ─── POST /api/auth/signup ────────────────────────────────────────────────────
router.post('/signup', async (req, res, next) => {
  const parsed = signupSchema.safeParse(req.body);
  if (!parsed.success) return next(validationError(parsed.error));
  // Trimmed and lowercased, so uniqueness (the pre-check and the constraints) ignores case.
  const { username, displayName, email, password } = parsed.data;

  try {
    // Prevent duplicate username OR email in one query
    if (await isEmailOrUsernameTaken(pool, email, username)) {
      return next(new AppError(409, ErrorCode.CONFLICT, 'Email or username is already taken.'));
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    // The user, their #general membership and their first session are created
    // together or not at all.
    const { newUser, token } = await withTransaction(async (client) => {
      const user = await createUser(client, { username, email, displayName, passwordHash });
      await addMember(client, await findGeneralId(client), user.id, 'member');
      return { newUser: user, token: await startSession(client, req, user.id) };
    });

    sessionCookie.set(res, token);
    res.status(201).json({
      user: { id: newUser.id, username: newUser.username, email: newUser.email },
    });
  } catch (err) {
    // Two signups can both pass the pre-check above before either inserts; the
    // unique constraint then rejects the second. That is a conflict, not a crash.
    if (err.code === PG_UNIQUE_VIOLATION) {
      return next(new AppError(409, ErrorCode.CONFLICT, 'Email or username is already taken.'));
    }
    logger.error({ err }, 'Signup error');
    next(new AppError(500, ErrorCode.INTERNAL_ERROR, 'Server error during signup.'));
  }
});

// ─── POST /api/auth/login ─────────────────────────────────────────────────────
router.post('/login', async (req, res, next) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return next(validationError(parsed.error));
  // The email is normalized the same way as at signup.
  const { email, password } = parsed.data;

  try {
    const user = await findUserByEmail(pool, email);

    // ⚠️  Intentionally same error for "not found" and "wrong password"
    //     — prevents attackers from discovering which emails are registered
    if (!user) {
      return next(new AppError(401, ErrorCode.INVALID_CREDENTIALS, 'Invalid email or password.'));
    }

    const isMatch = await bcrypt.compare(password, user.passwordHash);

    if (!isMatch) {
      return next(new AppError(401, ErrorCode.INVALID_CREDENTIALS, 'Invalid email or password.'));
    }

    sessionCookie.set(res, await startSession(pool, req, user.id));
    res.json({
      user: { id: user.id, username: user.username, email: user.email },
    });
  } catch (err) {
    logger.error({ err }, 'Login error');
    next(new AppError(500, ErrorCode.INTERNAL_ERROR, 'Server error during login.'));
  }
});

// ─── GET /api/auth/me ─────────────────────────────────────────────────────────
// The client cannot read the httpOnly cookie, so it asks here who is logged in.
router.get('/me', requireSession, (req, res) => {
  res.json({ user: req.user });
});

// ─── POST /api/auth/logout ────────────────────────────────────────────────────
// Ends this session only; the user's other sessions stay. Without a valid session
// it still clears the cookie and answers 204, so logging out never fails.
router.post('/logout', async (req, res, next) => {
  const token = sessionCookie.read(req.headers.cookie);
  try {
    if (token) await deleteSession(pool, hashSessionToken(token));
  } catch (err) {
    logger.error({ err }, 'Logout error');
    return next(new AppError(500, ErrorCode.INTERNAL_ERROR, 'Server error during logout.'));
  }

  sessionCookie.clear(res);
  res.status(204).end();
});

export default router;