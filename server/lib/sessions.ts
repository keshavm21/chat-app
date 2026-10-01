// server/lib/sessions.ts
// Session tokens and the session cookie (docs/v2-design.md §6). A token only ever
// travels in the Set-Cookie and Cookie headers: the database stores its SHA-256.
import { createHash, randomBytes } from 'crypto';
import { parseCookie } from 'cookie';
import type { CookieOptions, Response } from 'express';
import { config } from '../config/env.js';
import { SESSION_MAX_AGE_MS } from './limits.js';

/** A new session token: 32 random bytes, base64url-encoded for the cookie. */
export function createSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** What the database stores and looks up instead of the token (sessions.token_hash). */
export function hashSessionToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

export const SESSION_ROOM_PREFIX = 'session:';

/**
 * The Socket.io room every socket of a session joins, so that ending the session can
 * disconnect them all. Named by the token's hash, never by the token.
 */
export function sessionRoom(tokenHash: Buffer): string {
  return `${SESSION_ROOM_PREFIX}${tokenHash.toString('hex')}`;
}

/**
 * The session cookie for a NODE_ENV. In production it is `__Host-relay_session`: the
 * prefix makes browsers insist on Secure, Path=/ and no Domain. Elsewhere it is
 * `relay_session` without Secure, because browsers differ on Secure cookies over
 * http://localhost, and the prefix requires Secure.
 */
export function sessionCookieFor(nodeEnv: string) {
  const production = nodeEnv === 'production';
  const name = production ? '__Host-relay_session' : 'relay_session';
  const options: CookieOptions = { httpOnly: true, secure: production, sameSite: 'lax', path: '/' };

  return {
    name,
    /** Sets the cookie of a new session. It lasts as long as the session's absolute limit. */
    set(res: Response, token: string): void {
      res.cookie(name, token, { ...options, maxAge: SESSION_MAX_AGE_MS });
    },
    clear(res: Response): void {
      res.clearCookie(name, options);
    },
    /** The session token in a Cookie header (an HTTP request's or the socket handshake's), if any. */
    read(cookieHeader: string | undefined): string | undefined {
      if (!cookieHeader) return undefined;
      return parseCookie(cookieHeader)[name] || undefined;
    },
  };
}

/** The app's session cookie. */
export const sessionCookie = sessionCookieFor(config.nodeEnv);
