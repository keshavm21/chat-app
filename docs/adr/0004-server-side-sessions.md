# ADR 0004: Server-side sessions in an httpOnly cookie, with three CSRF layers

- **Status:** Accepted (2026-09-28). Implemented in Phase 2 on the `phase-2` branch: migration `0003_sessions`, `server/lib/sessions.ts`, `server/http/requireSession.ts`, the socket handshake in `server/socket/socketHandler.js`, `server/socket/sessionSweep.ts` and `server/http/csrf.ts`. Reaches production through the release runbook in `docs/phase-2-implementation-plan.md` §15.
- **Decision record:** D3 in `docs/v2-design.md` §6 and §10; `docs/phase-2-implementation-plan.md` §2 (decision 1) and §16 (decisions 5 and 6).

## Context

Until Phase 2, login returned a JWT (`{ id, username }`, valid 7 days), which the client kept in `localStorage` and sent as `Authorization: Bearer` and in the socket handshake. That had four problems:

- Any script running on the page could read the token and use it elsewhere.
- Nothing could revoke it: logout only deleted the browser's copy, and the token stayed valid for 7 days.
- Logout did not disconnect the user's open sockets.
- A socket authenticated once, at the handshake, and outlived its token's expiry (audit §7.8).

Relay is one service that queries the database on every request anyway, so JWT's advantage, verification without a lookup, buys nothing here, while revocation is required.

## Decision

**Sessions**
- `sessions` (migration `0003`): `token_hash` (SHA-256, the primary key), `user_id` (deleted with the user), `created_at`, `last_seen_at`, `expires_at`, and the user agent (for the later session list, D11).
- The token is 32 random bytes, base64url-encoded. It exists only in the `Set-Cookie` and `Cookie` headers, which the logs redact; the database stores its hash, so a database leak yields no usable sessions.
- A session ends 30 days after login (`expires_at`) or after 7 days unused (`last_seen_at`). The lookup moves `last_seen_at` at most once an hour, in the same statement, so most requests write nothing.
- Every signup and login creates a new session and ignores any cookie the request carries, so a planted cookie cannot become a logged-in session (no session fixation).
- The session is checked in two places that must stay in step: `requireSession` for HTTP (401 `UNAUTHENTICATED` for every failure) and the socket handshake (which says "Authentication error: …" only for a missing or invalid session, so an outage does not log anyone out).

**The cookie**
- `relay_session; HttpOnly; SameSite=Lax; Path=/`, with `Max-Age` = 30 days. With `NODE_ENV=production` it is `__Host-relay_session` and `Secure`: the prefix makes browsers insist on `Secure`, `Path=/` and no `Domain`. Development omits both, because browsers differ on `Secure` cookies over `http://localhost`.
- JavaScript never sees it. The client asks `GET /api/auth/me` on start to learn who is logged in.

**Ending sessions**
- Logout deletes only its own session (§16, decision 6), clears the cookie and disconnects that session's sockets at once: each socket joins `session:<hash>`, and logout calls `disconnectSockets(true)` on that room.
- Every 5 minutes a sweep checks all connected sessions in one query, disconnects the sockets whose session was deleted, expired or went idle, and deletes ended rows. An open socket counts as use.

**CSRF, three layers**
1. `SameSite=Lax`: another site's requests do not carry the cookie, except top-level navigations, which are `GET`s and change nothing.
2. The `Origin` check: every `POST`, `PUT`, `PATCH` and `DELETE` under `/api` must come from `CLIENT_URL`'s origin, else 403. A missing `Origin` is refused, because browsers always send one with these methods.
3. JSON only: the same requests need `Content-Type: application/json`, else 415. A cross-origin JSON request needs a CORS preflight, which no other origin passes (after ADR 0005 there is no CORS at all).

The socket handshake has its own `Origin` check (Socket.io's `allowRequest`), because CORS does not protect WebSockets; with the WebSocket transport only (ADR 0005), every handshake carries an `Origin`.

## Alternatives considered

- **Keep the JWT in `localStorage`.** Readable by any script on the page, and not revocable.
- **A JWT in an httpOnly cookie.** Not readable by scripts, but still not revocable without a denylist, which puts state back and makes it a session with extra steps.
- **A short access JWT with a rotating refresh cookie.** Revocation only takes effect at the next refresh, and it needs rotation, reuse detection and two code paths, for a single service that queries the database anyway.
- **CSRF tokens** (synchronizer or double-submit). They work, but the three layers above already stop cross-site requests, need no client state and are easy to explain; a token adds a round trip and a failure mode.
- **`SameSite=Strict`.** A visitor arriving from a link (a résumé, an email) would look logged out on the first page load; `Lax` is enough because no state changes on `GET`.

## Consequences

- Every authenticated request and handshake costs one primary-key lookup, and at most one write per session per hour.
- Logout cuts off the session's sockets at once; an expired or deleted session's sockets go within 5 minutes (the sweep interval). The client then asks `/me` and returns to `/login`.
- Releasing Phase 2 logs every user out once, because their JWTs stop working; accounts and messages are kept.
- Tests: `sessions.test.ts` (cookie, hash storage, `/me`, expiry, idle timeout, hourly touch, logout, planted cookies), `sessionLifecycle.test.ts` (logout and the sweep on sockets), `security.test.ts` (the CSRF layers), `logger.test.ts` (redaction of `Cookie` and `Set-Cookie`). Breaking each rule fails its test.
- A later session list (D11) needs only endpoints and UI: the rows and user agents are already there.
