// server/http/rateLimits.ts
// Brute-force limits on login and signup (audit §7.1; docs/v2-design.md §6), and limits
// on user searches and channel creation. Counters live in memory, which is enough for one instance (D15, D16).
import type { Request } from 'express';
import { ipKeyGenerator, MemoryStore, rateLimit } from 'express-rate-limit';
import { AppError, ErrorCode } from '../lib/errors.js';
import type { RateLimit } from '../lib/limits.js';
import { loginSchema } from './schemas.js';

export interface RateLimits {
  login: RateLimit;
  signup: RateLimit;
  userSearch: RateLimit;
  channelCreation: RateLimit;
}

// The client's IP as Express sees it (req.ip, which honours `trust proxy`). IPv6
// addresses are grouped by their /56 network, which one client can easily change within.
const clientIp = (req: Request) => ipKeyGenerator(req.ip ?? '');

// The email normalized the same way login does, so its case or spaces cannot dodge the limit.
const loginEmail = (req: Request) => {
  const parsed = loginSchema.shape.email.safeParse(req.body?.email);
  return parsed.success ? parsed.data : '';
};

/**
 * The login, signup, user search and channel creation limiters, with fresh counters for each app (so each
 * test server starts from zero). stop() ends their stores' cleanup timers, for the
 * shutdown sequence.
 */
export function createRateLimiters(limits: RateLimits) {
  const stores = {
    login: new MemoryStore(),
    signup: new MemoryStore(),
    userSearch: new MemoryStore(),
    channelCreation: new MemoryStore(),
  };

  const common = {
    // RateLimit and RateLimit-Policy headers, and Retry-After when over the limit.
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    // Over the limit: 429 in the usual error envelope, through the error handler.
    handler: (_req: Request, _res: unknown, next: (err: AppError) => void) =>
      next(new AppError(429, ErrorCode.RATE_LIMITED, 'Too many attempts. Please try again later.')),
  } as const;

  return {
    // Failed logins per IP and email: one attacker cannot lock everyone behind their
    // IP out, nor lock a user out from everywhere. Successful logins do not count.
    login: rateLimit({
      ...common,
      ...limits.login,
      store: stores.login,
      keyGenerator: (req) => `${clientIp(req)}|${loginEmail(req)}`,
      skipSuccessfulRequests: true,
    }),
    // Signup attempts per IP, whatever their outcome.
    signup: rateLimit({
      ...common,
      ...limits.signup,
      store: stores.signup,
      keyGenerator: clientIp,
    }),
    // User searches per user and IP, so nobody can page through every username quickly,
    // and visitors sharing one account (the demo account) do not share one budget.
    // Runs after requireSession, which sets req.user.
    userSearch: rateLimit({
      ...common,
      ...limits.userSearch,
      store: stores.userSearch,
      keyGenerator: (req) => `${req.user!.id}|${clientIp(req)}`,
    }),
    // Channels created per user; attempts that fail (a taken name, bad input) do not count.
    // Runs after requireSession, which sets req.user.
    channelCreation: rateLimit({
      ...common,
      ...limits.channelCreation,
      store: stores.channelCreation,
      keyGenerator: (req) => `${req.user!.id}`,
      skipFailedRequests: true,
    }),
    stop() {
      for (const store of Object.values(stores)) store.shutdown();
    },
  };
}
