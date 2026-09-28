// server/lib/errors.ts
// Every REST error response has the shape { error: { code, message, details? } }.

/** Machine-readable error codes. The client keeps a matching list. */
export const ErrorCode = {
  VALIDATION_ERROR:    'VALIDATION_ERROR',    // 400: missing or invalid request fields
  INVALID_JSON:        'INVALID_JSON',        // 400: request body is not valid JSON
  BAD_REQUEST:         'BAD_REQUEST',         // 4xx: other request-body problems (too large, bad encoding)
  UNAUTHENTICATED:     'UNAUTHENTICATED',     // 401: no valid session (missing, unknown, expired or idle)
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS', // 401: wrong email or password
  FORBIDDEN:           'FORBIDDEN',           // 403: a state-changing request from an origin that is not allowed
  NOT_FOUND:           'NOT_FOUND',           // 404: unknown /api route
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE', // 415: a state-changing request whose body is not JSON
  CONFLICT:            'CONFLICT',            // 409: e.g. email or username already taken
  INTERNAL_ERROR:      'INTERNAL_ERROR',      // 500
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ErrorBody {
  error: { code: ErrorCode; message: string; details?: unknown };
}

export function errorBody(code: ErrorCode, message: string, details?: unknown): ErrorBody {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}

/** An expected error: the handler sends its status and message to the client as-is. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }

  toBody(): ErrorBody {
    return errorBody(this.code, this.message, this.details);
  }
}
