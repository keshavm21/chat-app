import jwt from 'jsonwebtoken';
import { config } from '../config/env.js';
import { AppError, ErrorCode } from '../lib/errors.js';

const verifyToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];

  // Expect header format:  Authorization: Bearer <token>
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next(new AppError(401, ErrorCode.UNAUTHENTICATED, 'Access denied. No token provided.'));
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, config.jwtSecret);
    req.user = decoded;   // shape: { id, username, iat, exp }
    next();
  } catch {
    return next(new AppError(403, ErrorCode.INVALID_TOKEN, 'Invalid or expired token.'));
  }
};

export default verifyToken;