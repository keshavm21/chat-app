import express from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import pool from '../db/connection.js';
import { withTransaction } from '../db/transaction.js';
import { config } from '../config/env.js';
import { AppError, ErrorCode } from '../lib/errors.js';
import { loginSchema, signupSchema, validationError } from '../http/schemas.js';
import { logger } from '../lib/logger.js';
import { createUser, findUserByEmail, isEmailOrUsernameTaken } from '../repositories/users.js';
import { addMember, findGeneralId } from '../repositories/conversations.js';

const router = express.Router();
const SALT_ROUNDS = 10;
const PG_UNIQUE_VIOLATION = '23505';

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

    // The user and their #general membership are created together or not at all.
    const newUser = await withTransaction(async (client) => {
      const user = await createUser(client, { username, email, displayName, passwordHash });
      await addMember(client, await findGeneralId(client), user.id, 'member');
      return user;
    });

    const token = jwt.sign(
      { id: newUser.id, username: newUser.username },
      config.jwtSecret,
      { expiresIn: '7d' }
    );

    res.status(201).json({
      token,
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

    const token = jwt.sign(
      { id: user.id, username: user.username },
      config.jwtSecret,
      { expiresIn: '7d' }
    );

    res.json({
      token,
      user: { id: user.id, username: user.username, email: user.email },
    });
  } catch (err) {
    logger.error({ err }, 'Login error');
    next(new AppError(500, ErrorCode.INTERNAL_ERROR, 'Server error during login.'));
  }
});

export default router;