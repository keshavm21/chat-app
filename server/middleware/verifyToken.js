import jwt from 'jsonwebtoken';
import { config } from '../config/env.js';

const verifyToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];

  // Expect header format:  Authorization: Bearer <token>
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, config.jwtSecret);
    req.user = decoded;   // shape: { id, username, iat, exp }
    next();
  } catch {
    return res.status(403).json({ error: 'Invalid or expired token.' });
  }
};

export default verifyToken;