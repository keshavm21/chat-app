<div align="center">

# Relay

**A full-stack real-time group chat app — JWT auth, live Socket.io messaging, and PostgreSQL history.**

[![CI](https://github.com/keshavm21/chat-app/actions/workflows/ci.yml/badge.svg)](https://github.com/keshavm21/chat-app/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-24-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![React](https://img.shields.io/badge/react-19-20232a?logo=react&logoColor=61dafb)](https://react.dev)
[![Socket.io](https://img.shields.io/badge/socket.io-4.x-010101?logo=socket.io)](https://socket.io)
[![PostgreSQL](https://img.shields.io/badge/postgresql-17-4169e1?logo=postgresql&logoColor=white)](https://www.postgresql.org)

[Live Demo](https://relay-chat-app.vercel.app/) · [Report a Bug](https://github.com/keshavm21/chat-app/issues)

</div>

---

## Demo

![Relay in action](./docs/demo.gif)

| Landing | Chat Room |
|:---:|:---:|
| ![Landing page](./docs/landing.png) | ![Chat room](./docs/chat.png) |

---

## Features

- 🔐 **JWT authentication** — signup, login, 7-day tokens, and sessions that survive page refreshes
- ⚡ **Real-time messaging** — WebSocket-powered via Socket.io; no polling, no page reloads
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
| 2–8 — sessions, conversations, messaging, sync, awareness, editing, hardening | Planned |

- [Current-state audit](./docs/current-state-audit.md) — the analysis the V2 work starts from
- [V2 design](./docs/v2-design.md) — target architecture, decisions (D1–D17) and the full roadmap
- [Phase 0 implementation plan](./docs/phase-0-implementation-plan.md) — tasks, verification and the completion record
- [Phase 1 implementation plan](./docs/phase-1-implementation-plan.md) — milestones, the completion record and the production cutover runbook
- [Architecture decision records](./docs/adr/) — the fresh database and migration layout, integer IDs, the per-conversation message sequence

---

## Tech Stack

| Layer | Technology | Notes |
|---|---|---|
| Frontend | React 19 (Vite) | SPA with fast HMR dev experience |
| Styling | Tailwind CSS v3 | Utility-first; rapid, consistent UI |
| Backend | Node.js + Express 5 | REST API, ESM throughout |
| Real-time | Socket.io 4.x | WebSocket abstraction with fallback transport |
| Auth | JWT + bcrypt | Stateless; token verified on HTTP and WebSocket layers |
| Database | PostgreSQL 17 | Neon in production, Docker locally; schema managed by SQL migrations (node-pg-migrate) |
| Validation and errors | zod, one JSON error envelope | The server refuses to start with invalid config; every REST error is `{ error: { code, message } }` |
| Logging | pino + pino-http | JSON logs with tokens, cookies and passwords redacted |
| Testing | Vitest + Supertest + socket.io-client | Integration tests against a real PostgreSQL test database |
| Tooling | TypeScript (incremental), ESLint, GitHub Actions | CI runs lint, typecheck, tests and build on every push and pull request |
| Deployment | Render + Vercel | Render for the Express server; Vercel for the React frontend |

---

## Project Structure

```
chat-app/
├── .github/workflows/ci.yml         — CI: lint, typecheck, test, build
├── docker-compose.yml               — local PostgreSQL 17 (relay_dev + relay_test)
├── .env.example                     — server environment variables
├── docs/                            — audit, V2 design, phase plans, ADRs
├── client/                          ← React frontend (Vite)
│   ├── vercel.json                  — serves index.html for every client route on Vercel
│   └── src/
│       ├── api/axios.js             — Axios instance with JWT interceptor
│       ├── components/              — ProtectedRoute, GuestRoute
│       ├── context/                 — AuthProvider (token + user in localStorage), useAuth
│       ├── lib/errors.ts            — reads error messages from server responses
│       ├── pages/                   — Landing, Login, Signup, Chat
│       ├── socket.js                — Socket.io singleton (autoConnect: false)
│       └── App.jsx                  — React Router route definitions
└── server/                          ← Express backend
    ├── config/env.ts                — loads .env and validates every variable
    ├── db/                          — PostgreSQL connection pool, withTransaction()
    ├── http/                        — request schemas (zod), JSON 404, the central error handler
    ├── lib/                         — AppError + error codes, shared limits, pino logger
    ├── middleware/verifyToken.js    — JWT verification middleware
    ├── migrations/                  — SQL migrations (0001 Phase 0 schema, 0002 V2 schema)
    ├── repositories/                — SQL for users, conversations and messages
    ├── routes/auth.js               — POST /api/auth/signup, /login
    ├── routes/messages.js           — GET /api/messages (last 50 of #general, protected)
    ├── socket/socketHandler.js      — Socket.io event handlers
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

Then set `JWT_SECRET` in `.env` to a long random string, for example the output of `openssl rand -hex 32`. `.env.example` documents every variable; its `DATABASE_URL` already points at `relay_dev` (keep `?sslmode=disable` for the local database). The server checks all variables at startup and exits with a message naming any that are missing or invalid.

The client needs no configuration locally: it talks to `http://localhost:5001` unless `VITE_API_URL` is set (for example in `client/.env.local`).

### 4. Create the schema

```bash
cd server && npm run migrate
```

This applies the SQL migrations in `server/migrations/` to `relay_dev`: `0001` (the Phase 0 schema) and `0002` (the V2 schema, which replaces it and creates the `#general` channel). Running it again reports that there is nothing to migrate. `npm run migrate:down` rolls back the last migration.

### 5. Run

```bash
# Terminal 1 — server on http://localhost:5001 (restarts on file changes)
cd server && npm run dev

# Terminal 2 — client
cd client && npm run dev
```

Open [http://localhost:5173](http://localhost:5173). Open a second browser tab to see real-time messaging in action.

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

### Neon — PostgreSQL database

1. Create a project at [neon.tech](https://neon.tech) and copy its **direct** (not pooled) connection string. It looks like `postgresql://user:pass@host/dbname?sslmode=require`.
2. Create the schema by running the migrations against it once, from your machine:

   ```bash
   cd server && DATABASE_URL='<neon connection string>' npm run migrate
   ```

3. Use the connection string as `DATABASE_URL` in the Render environment variables (below).

> Production has run on a database built by these migrations since the Phase 1 cutover on 2026-09-27. To move production to a new database again, follow the cutover runbook in the [Phase 1 plan, §13](./docs/phase-1-implementation-plan.md#13-production-cutover-runbook): it also covers rotating `JWT_SECRET`.

### Render — Express server

1. In [Render](https://render.com): **New** → **Web Service** → connect the GitHub repo.
2. Set the **Root Directory** to `server/`.
3. Build command: `npm ci --include=dev && npm run build` · Start command: `npm start`. The build needs the dev dependencies because it compiles with TypeScript.
4. Add environment variables in the Render dashboard:

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | your Neon connection string |
   | `JWT_SECRET` | a long random string |
   | `CLIENT_URL` | your Vercel frontend URL, e.g. `https://your-app.vercel.app` |
   | `LOG_LEVEL` | optional; defaults to `info` |

   Render sets `NODE_ENV` and `PORT` itself. If a variable is missing or invalid, the server exits at startup and the log names it.
5. Note your Render server URL (e.g. `https://relay-server.onrender.com`).

On every deploy Render sends the old instance `SIGTERM`. The server shuts down gracefully, and connected clients reconnect to the new instance automatically.

### Vercel — React frontend

1. Import the `client/` folder as a new Vercel project.
2. Set the environment variable:

   | Variable | Value |
   |---|---|
   | `VITE_API_URL` | `https://relay-server.onrender.com` |

3. Build command: `npm run build` · Output directory: `dist`.
4. Copy the Vercel URL back into Render's `CLIENT_URL` variable and redeploy.

`client/vercel.json` rewrites every path that is not a file to `/index.html`, so reloading the page or opening `/chat`, `/login` or `/signup` directly loads the app, and React Router shows the page. Without it, Vercel answers those paths with a 404.

---

## How It Works

### Authentication

1. User signs up → server validates the username and email and stores them lowercase, hashes the password with bcrypt, adds the user to `#general` and returns a signed JWT
2. React stores the token in `localStorage`; an Axios interceptor attaches it as `Authorization: Bearer <token>` on every outgoing request
3. Express `verifyToken` middleware validates the token on all protected HTTP routes
4. Socket.io verifies the same token during the WebSocket handshake — invalid tokens are rejected before the connection is established

### Real-time messaging

1. On mounting `/chat`, the client calls `socket.connect()` with the JWT in the auth payload
2. The user sends a message → client emits `new_message`
3. In one database transaction, the server takes `#general`'s next sequence number (`seq`) and stores the message if the sender is a member. Locking the channel's row makes the numbers gapless and puts them in commit order, and a failed send uses none up
4. After the commit, the server broadcasts the complete message object, including `seq`, to all connected clients
5. Every open browser receives the `message` event and appends it to the list — no refresh, no polling. History (`GET /api/messages`) returns the last 50 messages by `seq`

### Typing indicators

1. Client emits a `typing` event on each keystroke
2. Server broadcasts `user_typing` to all other clients on the first event of a burst, then starts a 3-second auto-clear timer
3. After 3 seconds of silence, server broadcasts `user_stop_typing`
4. On disconnect, the server immediately clears any in-progress typing state for that user
