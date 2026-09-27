import express from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import pool from '../db/connection.js';
import { config } from '../config/env.js';
import { AppError, ErrorCode } from '../lib/errors.js';

const router = express.Router();
const SALT_ROUNDS = 10;

// ─── POST /api/auth/signup ────────────────────────────────────────────────────
router.post('/signup', async (req, res, next) => {
  const { username, email, password } = req.body;

  if (!username || !email || !password) {
    return next(new AppError(400, ErrorCode.VALIDATION_ERROR, 'All fields are required.'));
  }

  try {
    // Prevent duplicate username OR email in one query
    const existing = await pool.query(
      'SELECT id FROM users WHERE email = $1 OR username = $2',
      [email, username]
    );

    if (existing.rows.length > 0) {
      return next(new AppError(409, ErrorCode.CONFLICT, 'Email or username is already taken.'));
    }

    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

    const result = await pool.query(
      `INSERT INTO users (username, email, password)
       VALUES ($1, $2, $3)
       RETURNING id, username, email`,
      [username, email, hashedPassword]
    );

    const newUser = result.rows[0];

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
    console.error('Signup error:', err.message);
    next(new AppError(500, ErrorCode.INTERNAL_ERROR, 'Server error during signup.'));
  }
});

// ─── POST /api/auth/login ─────────────────────────────────────────────────────
router.post('/login', async (req, res, next) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return next(new AppError(400, ErrorCode.VALIDATION_ERROR, 'Email and password are required.'));
  }

  try {
    const result = await pool.query(
      'SELECT id, username, email, password FROM users WHERE email = $1',
      [email]
    );

    // ⚠️  Intentionally same error for "not found" and "wrong password"
    //     — prevents attackers from discovering which emails are registered
    if (result.rows.length === 0) {
      return next(new AppError(401, ErrorCode.INVALID_CREDENTIALS, 'Invalid email or password.'));
    }

    const user = result.rows[0];
    const isMatch = await bcrypt.compare(password, user.password);

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
    console.error('Login error:', err.message);
    next(new AppError(500, ErrorCode.INTERNAL_ERROR, 'Server error during login.'));
  }
});

export default router;