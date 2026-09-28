<div align="center">

# Relay

**A full-stack real-time group chat app — server-side sessions, live Socket.io messaging, and PostgreSQL history.**

[![CI](https://github.com/keshavm21/chat-app/actions/workflows/ci.yml/badge.svg)](https://github.com/keshavm21/chat-app/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-24-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![React](https://img.shields.io/badge/react-19-20232a?logo=react&logoColor=61dafb)](https://react.dev)
[![Socket.io](https://img.shields.io/badge/socket.io-4.x-010101?logo=socket.io)](https://socket.io)
[![PostgreSQL](https://img.shields.io/badge/postgresql-17-4169e1?logo=postgresql&logoColor=white)](https://www.postgresql.org)

[Live Demo](https://chat-app-7wix.onrender.com/) · [Report a Bug](https://github.com/keshavm21/chat-app/issues)

</div>

---

## Demo

![Relay in action](./docs/demo.gif)

| Landing | Chat Room |
|:---:|:---:|
| ![Landing page](./docs/landing.png) | ![Chat room](./docs/chat.png) |

---

## Features

- 🔐 **Server-side sessions** — an httpOnly cookie no script can read, revocable at logout, which also cuts off that session's live connections
- 🛡️ **Security baseline** — CSRF defenses (SameSite, Origin checks, JSON-only), login and signup rate limits, password rules, security headers
- ⚡ **Real-time messaging** — WebSockets via Socket.io; no polling, no page reloads
- 🗄️ **Persistent history** — last 50 messages loaded from PostgreSQL on room join
- 👥 **Live online count** — updates instantly on connect and disconnect
- ✍️ **Typing indicators** — server debounces keystrokes and auto-clears after 3 seconds of silence
- 💬 **Message grouping** — consecutive messages from the same user share one avatar and header
- 📱 **Fully responsive** — works on mobile and desktop

---

## Project Status and Docs

Relay is being evolved into **Relay V2**: public and private channels, direct messages, per-channel roles, and reliable delivery across reconnects. The work is done in phases.

| Phase | Status |
|---|---|
| **0 — Foundation:** migrations, TypeScript tooling, integration tests, CI, config validation, error envelope, structured logging, graceful shutdown | ✅ Complete |
| **1 — V2 data model** on a fresh database: channels, DMs and memberships in the schema, gapless per-conversation message order, signup validation | ✅ Complete, in production since 2026-09-27 |
| **2 — Sessions and security baseline:** server-side sessions in an httpOnly cookie, logout that disconnects live sockets, CSRF defenses, rate limits, password rules, helmet, one origin for app and API, verified database TLS | ✅ Complete on the `phase-2` branch; release pending |
| 3–8 — conversations, messaging, sync, awareness, editing, hardening | Planned |

- [Current-state audit](./docs/current-state-audit.md) — the analysis the V2 work starts from
- [V2 design](./docs/v2-design.md) — target architecture, decisions (D1–D17) and the full roadmap
- [Phase 0 implementation plan](./docs/phase-0-implementation-plan.md) — tasks, verification and the completion record
- [Phase 1 implementation plan](./docs/phase-1-implementation-plan.md) — milestones, the completion record and the production cutover runbook
- [Phase 2 implementation plan](./docs/phase-2-implementation-plan.md) — milestones, decisions, the completion record and the release runbook
- [Architecture decision records](./docs/adr/) — the fresh database and migration layout, integer IDs, the per-conversation message sequence, server-side sessions, the one-origin production topology

---

## Tech Stack

| Layer | Technology | Notes |
|---|---|---|
| Frontend | React 19 (Vite) | SPA with fast HMR dev experience |
| Styling | Tailwind CSS v3 | Utility-first; rapid, consistent UI |
| Backend | Node.js + Express 5 | REST API, ESM throughout |
| Real-time | Socket.io 4.x | WebSocket transport only; the handshake is checked for the session and the origin |
| Auth | Server-side sessions + bcrypt | Random token in an httpOnly cookie, stored only as a SHA-256 hash; checked on every request and socket handshake |
| Security | helmet, express-rate-limit | Security headers; CSRF defenses (SameSite, Origin checks, JSON-only bodies); login and signup rate limits |
| Database | PostgreSQL 17 | Neon in production, Docker locally; schema managed by SQL migrations (node-pg-migrate) |
| Validation and errors | zod, one JSON error envelope | The server refuses to start with invalid config; every REST error is `{ error: { code, message } }` |
| Logging | pino + pino-http | JSON logs with cookies and passwords redacted, and the client IP |
| Testing | Vitest + Supertest + socket.io-client | Integration tests against a real PostgreSQL test database |
| Tooling | TypeScript (incremental), ESLint, GitHub Actions | CI runs lint, typecheck, tests and build on every push and pull request |
| Deployment | Render | Express serves the API, the socket and the built React app from one origin; Neon hosts PostgreSQL |

---

## Project Structure

```
chat-app/
├── .github/workflows/ci.yml         — CI: lint, typecheck, test, build
├── docker-compose.yml               — local PostgreSQL 17 (relay_dev + relay_test)
├── .env.example                     — server environment variables
├── docs/                            — audit, V2 design, phase plans, ADRs
├── client/                          ← React frontend (Vite)
│   ├── vite.config.js               — dev proxy of /api and /socket.io to the server (one origin)
│   ├── vercel.json                  — redirects the old Vercel URL to Render
│   └── src/
│       ├── api/axios.js             — Axios instance (same origin; the cookie goes along)
│       ├── components/              — ProtectedRoute, GuestRoute
│       ├── context/                 — AuthProvider (asks /api/auth/me; logout), useAuth
│       ├── lib/errors.ts            — reads error messages from server responses
│       ├── pages/                   — Landing, Login, Signup, Chat
│       ├── socket.js                — Socket.io singleton (WebSocket only, autoConnect: false)
│       └── App.jsx                  — React Router route definitions
└── server/                          ← Express backend
    ├── config/env.ts                — loads .env and validates every variable
    ├── db/                          — PostgreSQL connection pool, withTransaction()
    ├── http/                        — requireSession, CSRF checks, rate limits, serving the client,
    │                                  request schemas (zod), JSON 404, the central error handler
    ├── lib/                         — sessions (token, hash, cookie), AppError + error codes, shared limits, logger
    ├── migrations/                  — SQL migrations (0001 Phase 0, 0002 V2 schema, 0003 sessions)
    ├── repositories/                — SQL for users, conversations, messages and sessions
    ├── routes/auth.js               — POST /api/auth/signup, /login, /logout; GET /api/auth/me
    ├── routes/messages.js           — GET /api/messages (last 50 of #general, needs a session)
    ├── socket/                      — Socket.io handlers and handshake; the 5-minute session sweep
    ├── test/                        — integration tests
    ├── app.js                       — builds Express + Socket.io (without listening)
    └── index.js                     — starts the server; graceful shutdown
```

---

## Local Setup

All commands start from the repository root.

### Prerequisites

- Node.js 24 (22.12+ also works; CI and Render use 24)
- Docker with Docker Compose, for the local PostgreSQL

### 1. Clone and install

```bash
git clone https://github.com/keshavm21/chat-app.git
cd chat-app

cd server && npm install
cd ../client && npm install
cd ..
```

### 2. Start PostgreSQL

```bash
docker compose up -d --wait
```

This starts PostgreSQL 17 on `localhost:5433` (not 5432, so it doesn't clash with a locally installed PostgreSQL). On first start it creates two databases: `relay_dev` for the app and `relay_test` for the tests. `docker compose down` stops it; `docker compose down -v` also deletes the data.

### 3. Environment variables

```bash
cp .env.example .env
```

The defaults work as they are. `.env.example` documents every variable; its `DATABASE_URL` already points at `relay_dev` (keep `?sslmode=disable` for the local database). The server checks all variables at startup and exits with a message naming any that are missing or invalid.

The client needs no configuration: in development Vite serves it on `http://localhost:5173` and proxies `/api` and `/socket.io` to the server, so the browser sees one origin, as in production.

### 4. Create the schema

```bash
cd server && npm run migrate
```

This applies the SQL migrations in `server/migrations/` to `relay_dev`: `0001` (the Phase 0 schema), `0002` (the V2 schema, which replaces it and creates the `#general` channel) and `0003` (sessions). Running it again reports that there is nothing to migrate. `npm run migrate:down` rolls back the last migration.

### 5. Run

```bash
# Terminal 1 — server on http://localhost:5001 (restarts on file changes)
cd server && npm run dev

# Terminal 2 — client on http://localhost:5173 (proxies /api and /socket.io to the server)
cd client && npm run dev
```

Open [http://localhost:5173](http://localhost:5173). Open a second browser tab to see real-time messaging in action, and a private window to chat as a second user.

The server logs JSON lines. For readable output, run `npm run dev | npx pino-pretty` instead.

### 6. Tests and checks

```bash
# Server: integration tests (needs the database from step 2), then static checks
cd server && npm test
npm run lint && npm run typecheck && npm run build

# Client
cd ../client && npm run lint && npm run typecheck && npm run build
```

`npm test` runs against `relay_test` and applies the migrations itself. It refuses to run against any database that is not a local `*_test` database, so it cannot touch `relay_dev` or production. CI runs the same checks on every push and pull request.

---

## Deployment

Render runs one web service: Express serves the API, the WebSocket and the built React app from one origin, so the session cookie is first-party (see [ADR 0005](./docs/adr/0005-production-cookie-topology.md)). Neon hosts PostgreSQL.

> Production runs Phase 1 until the Phase 2 release. To move the existing deployment over, follow the release runbook in the [Phase 2 plan, §15](./docs/phase-2-implementation-plan.md#15-release-runbook-prepared-not-executed-in-phase-2); the steps below describe a deployment from scratch.

### Neon — PostgreSQL database

1. Create a project at [neon.tech](https://neon.tech) and copy its **direct** (not pooled) connection string. Change its `sslmode=require` to **`sslmode=verify-full`** (keep `channel_binding=require`): the server refuses to start with any other `sslmode` for a database that is not local, so the connection always checks the certificate and host name.
2. Create the schema by running the migrations against it once, from your machine:

   ```bash
   cd server && DATABASE_URL='<neon connection string>' npm run migrate
   ```

3. Use the same connection string as `DATABASE_URL` on Render (below).

### Render — the app

1. In [Render](https://render.com): **New** → **Web Service** → connect the GitHub repo.
2. Leave the **Root Directory** empty (the repository root): the service builds both projects.
3. Build command:

   ```bash
   npm ci --prefix client && npm run build --prefix client && npm ci --include=dev --prefix server && npm run build --prefix server
   ```

   Start command: `npm start --prefix server`. The server build needs the dev dependencies because it compiles with TypeScript.
4. Add environment variables in the Render dashboard:

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | the Neon connection string, with `sslmode=verify-full` |
   | `CLIENT_URL` | the service's own URL, e.g. `https://chat-app-7wix.onrender.com`: the only origin allowed to change state or open a socket |
   | `NODE_ENV` | `production`: the session cookie becomes `__Host-relay_session` with `Secure` |
   | `TRUST_PROXY` | `1`: Render's proxy adds the client IP to `X-Forwarded-For`, which the rate limits and logs use |
   | `LOG_LEVEL` | optional; defaults to `info` |

   Render sets `PORT` itself. If a variable is missing or invalid, the server exits at startup and the log names it.
5. After the first deploy, check `TRUST_PROXY`: the request log lines' `ip` should be your public IP, also when you send a request with `X-Forwarded-For: 1.2.3.4`.

On every deploy Render sends the old instance `SIGTERM`. The server shuts down gracefully, and connected clients reconnect to the new instance automatically. On Render's free tier the instance sleeps when idle, so the first visit after a while waits for it to wake up.

### The old Vercel URL

The client used to be deployed on Vercel. `client/vercel.json` now redirects every path of that project to the same path on Render (a temporary 307 for now), so old links keep working.

---

## How It Works

### Authentication

1. Signup validates the username, email and password (8+ characters, at most 72 bytes: bcrypt's limit), stores the username and email lowercase and the password as a bcrypt hash, and adds the user to `#general`.
2. Signup and login each start a **server-side session**: a random 32-byte token goes into an `HttpOnly`, `SameSite=Lax` cookie, and the database stores only its SHA-256 hash. JavaScript never sees the token; the app asks `GET /api/auth/me` who is logged in.
3. Every protected request and every socket handshake looks the session up. A session ends 30 days after login, after 7 days unused, or at logout.
4. Logout deletes that session and disconnects its live sockets at once; the user's other devices stay logged in. Every 5 minutes, a sweep disconnects the sockets of sessions that expired or were deleted.
5. Brute force is limited: 10 failed logins per 15 minutes per IP and email, 20 signups per hour per IP. Login takes as long for an unknown email as for a wrong password, so it does not reveal who has an account.

### Cross-site protection

A page on another site cannot act as the user: the cookie is `SameSite=Lax`; every state-changing request must carry the app's own `Origin` and a JSON body; the WebSocket handshake is refused from any other origin; and there is no CORS, so no other site can read a response. See [ADR 0004](./docs/adr/0004-server-side-sessions.md).

### Real-time messaging

1. On mounting `/chat`, the client opens a WebSocket; the browser sends the session cookie with the handshake
2. The user sends a message → client emits `new_message`
3. In one database transaction, the server takes `#general`'s next sequence number (`seq`) and stores the message if the sender is a member. Locking the channel's row makes the numbers gapless and puts them in commit order, and a failed send uses none up
4. After the commit, the server broadcasts the complete message object, including `seq`, to all connected clients
5. Every open browser receives the `message` event and appends it to the list — no refresh, no polling. History (`GET /api/messages`) returns the last 50 messages by `seq`

### Typing indicators

1. Client emits a `typing` event on each keystroke
2. Server broadcasts `user_typing` to all other clients on the first event of a burst, then starts a 3-second auto-clear timer
3. After 3 seconds of silence, server broadcasts `user_stop_typing`
4. On disconnect, the server immediately clears any in-progress typing state for that user
