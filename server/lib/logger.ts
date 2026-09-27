// server/lib/logger.ts
// The server's single logger: JSON lines on stdout (pino defaults). Use it instead of console.*.
// Log errors as `logger.error({ err }, 'message')` so pino serializes the message and stack.
import pino, { type LoggerOptions } from 'pino';
import { config } from '../config/env.js';

export const loggerOptions = {
  level: config.logLevel,
  redact: {
    paths: [
      'req.headers.authorization', // JWT bearer token
      'req.headers.cookie',        // browsers send every localhost cookie to every port
      'password',
      '*.password',
      '*.*.password',              // e.g. { req: { body: { password } } }
      'err.detail',                // Postgres DETAIL can contain row values (e.g. a password hash)
      'err.client',                // pg-pool attaches the whole client, incl. the DB password, to pool errors
    ],
  },
} satisfies LoggerOptions;

export const logger = pino(loggerOptions);
