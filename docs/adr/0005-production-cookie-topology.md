# ADR 0005: Serve the client from Express, so the app has one origin

- **Status:** Accepted (2026-09-28). Implemented in Phase 2, milestone M5: `server/http/spa.ts`, `server/app.js`, `client/vite.config.js`, `client/src/socket.js`, `client/vercel.json`. Takes effect at the release (`docs/phase-2-implementation-plan.md` §15), when Render starts building both projects.
- **Decision record:** D4 in `docs/v2-design.md` §6, §8 and §10 (the open item on the production cookie topology); `docs/phase-2-implementation-plan.md` §16, decisions 1 and 7.

## Context

Until Phase 2 the client ran on Vercel (`relay-chat-app.vercel.app`) and the API on Render (`chat-app-7wix.onrender.com`). Both `vercel.app` and `onrender.com` are on the Public Suffix List, so the two are different *sites*, not just different origins. For the session cookie of ADR 0004 that is fatal:

- A `SameSite=Lax` cookie is not sent with cross-site `fetch`, XHR or WebSocket requests, so the app could not stay logged in.
- `SameSite=None` would make it a third-party cookie, which Safari blocks outright.

Client and API therefore had to become the same site before Phase 2 could reach production. Relay is a portfolio project on free tiers, with no budget for a domain.

## Decision

- **Express serves the built client** (`client/dist`) next to the API: hashed `/assets/*` with a year's immutable cache, a missing asset as 404, and `index.html` with `no-cache` for every other `GET` outside `/api` and `/socket.io`. The app, the API and the socket share one origin, so the cookie is first-party.
- **No CORS at all.** The `cors` middleware and Socket.io's `cors` option are gone: no other origin may read a response. The allowed origin of the CSRF checks is the app's public URL, `CLIENT_URL`.
- **One origin in development too:** Vite proxies `/api` and `/socket.io` (with WebSockets) to the server, and the client always uses relative URLs. `VITE_API_URL` is no longer read.
- **WebSocket only** (decision 7): the server and client use Socket.io's WebSocket transport, with no HTTP long-polling. Browsers send no `Origin` on a same-origin `GET`, so a polling handshake would fail the handshake's `Origin` check (ADR 0004); a WebSocket handshake always carries one.
- **Render builds both projects** (root directory: the repository; build: both `npm ci` and `npm run build`; start: the server). The Vercel project becomes a temporary (307) redirect of every path to the same path on Render, through `client/vercel.json`, so old links keep working and a rollback is not stuck in browser caches.

## Alternatives considered

- **A custom domain** with `app.` and `api.` subdomains: same site, almost no code, and the client stays on Vercel, whose landing page would load at once even while Render's free instance wakes up. It needs a domain and DNS on two providers, which cost money. It stays possible later (D4): only `CLIENT_URL` and DNS change.
- **`SameSite=None` cross-site cookies.** Safari blocks third-party cookies, so Safari users could not log in.
- **Proxying the API through Vercel rewrites.** One origin as well, but Vercel's rewrites are believed not to carry WebSockets (design §8), and every request would take an extra hop.
- **Keeping the JWT in a header.** Avoids cookies altogether, but brings back a token that scripts can read (ADR 0004).

## Consequences

- On Render's free tier a sleeping instance makes the *whole page* wait for the cold start, not only the first API call; this is the accepted cost of spending nothing.
- One deploy ships client and server together, so they can never be out of step.
- CORS configuration is gone, and the CSRF checks compare against a single origin.
- Clients on networks that block WebSockets cannot connect, since there is no polling fallback. Render supports WebSockets, and such networks are rare.
- The public URL changes to `https://chat-app-7wix.onrender.com`; `relay-chat-app.vercel.app` redirects there, and the redirect can become permanent (308) once the release has settled.
- Tests: `spa.test.ts` (against a fixture build, so server tests need no client build: client routes, caching, missing assets, the `/api` JSON 404), `security.test.ts` (no CORS headers; long-polling refused), `env.test.ts`. Checked in headless Chrome with the production build and `NODE_ENV=production`: `__Host-relay_session` with `Secure`, one origin for every request, the socket over WebSocket, a reload of `/chat` still logged in.
