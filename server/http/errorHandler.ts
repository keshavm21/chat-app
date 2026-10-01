// server/http/errorHandler.ts
import type { ErrorRequestHandler } from 'express';
import { AppError, ErrorCode, errorBody } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

/**
 * Last middleware in the chain: turns every error into the JSON envelope.
 * - AppError             → its own status, code and message
 * - bad JSON body        → 400 INVALID_JSON
 * - other body errors    → their 4xx status (e.g. 413 too large), BAD_REQUEST
 * - bad path encoding    → 400 BAD_REQUEST (e.g. /api/conversations/%E0/messages)
 * - anything else        → logged here, then a generic 500 (no stack or details sent)
 */
export const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) return next(err);

  if (err instanceof AppError) {
    res.status(err.status).json(err.toBody());
    return;
  }

  // Errors from express.json() (body-parser) carry a `type` and a safe-to-expose 4xx status.
  if (err?.type === 'entity.parse.failed') {
    res.status(400).json(errorBody(ErrorCode.INVALID_JSON, 'Request body is not valid JSON.'));
    return;
  }
  if (typeof err?.type === 'string' && err.expose === true && err.status >= 400 && err.status < 500) {
    res.status(err.status).json(errorBody(ErrorCode.BAD_REQUEST, err.message));
    return;
  }
  // The router could not percent-decode a path parameter such as :id; it marks that 400.
  if (err instanceof URIError && (err as URIError & { status?: number }).status === 400) {
    res.status(400).json(errorBody(ErrorCode.BAD_REQUEST, 'Malformed URL.'));
    return;
  }

  logger.error({ err }, 'Unhandled error');
  res.status(500).json(errorBody(ErrorCode.INTERNAL_ERROR, 'Internal server error.'));
};
