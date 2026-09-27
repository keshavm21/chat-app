// server/http/notFound.ts
import type { RequestHandler } from 'express';
import { AppError, ErrorCode } from '../lib/errors.js';

/** Mounted on /api after all routes: any /api request no route handled gets a JSON 404. */
export const notFound: RequestHandler = (_req, _res, next) => {
  next(new AppError(404, ErrorCode.NOT_FOUND, 'Route not found.'));
};
