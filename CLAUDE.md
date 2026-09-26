# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Relay: a single-room real-time group chat. Two independent npm projects, no root `package.json`:

- `server/` — Express 5 + Socket.io 4 + `pg` (PostgreSQL), ESM (`"type": "module"`), plain JS
- `client/` — React 19 + Vite + Tailwind v3 + React Router 7, plain JSX

Deployed as server on Render, client on Vercel, DB on Neon.

## Commands

```bash
# Server (run from server/)
npm install
npm run dev        # node --watch index.js
npm start          # node index.js

# Client (run from client/)
npm install
npm run dev        # Vite dev server on :5173
npm run build
npm run lint       # eslint .
npm run preview
```

There is no test suite in either project (server's `npm test` is a placeholder that exits 1).

## Environment

- Server env lives in a `.env` at the **repo root**, not in `server/`. Both `server/index.js` and `server/db/connection.js` load it via a path resolved relative to their own file location.
- Server vars: `DB_USER`, `DB_HOST`, `DB_NAME`, `DB_PASSWORD`, `DB_PORT` (local) or `DATABASE_URL` (production; takes precedence and enables SSL), plus `JWT_SECRET`, `PORT` (default 5001), `CLIENT_URL` (default `http://localhost:5173`, used for both Express and Socket.io CORS).
- Client: `client/.env.local` with `VITE_API_URL=http://localhost:5001`. Note the fallbacks disagree: `client/src/socket.js` falls back to `:5001`, but `client/src/api/axios.js` falls back to `:5000` — always set `VITE_API_URL`.
- No migrations exist; the `users` and `messages` table schema is in README.md ("Create the database"). `messages.username` is denormalized from `users` at insert time.

## Architecture

**Auth is JWT-only, enforced in two places with the same secret.** Tokens (`{ id, username }`, 7-day expiry) are issued by `server/routes/auth.js`. HTTP routes are protected by `server/middleware/verifyToken.js` (sets `req.user`); WebSocket connections are authenticated separately by an `io.use` middleware in `server/socket/socketHandler.js` that reads `socket.handshake.auth.token` (sets `socket.user`). Changes to token shape or verification must be made in both.

**Client token storage** uses localStorage keys `relay_token` and `relay_user`, owned by `client/src/context/AuthContext.jsx`. Both the Axios instance (request interceptor) and the Socket.io client (`auth` callback) read `relay_token` directly from localStorage rather than from context, so the socket picks up a fresh token on each reconnect without being recreated.

**Message flow:** history is fetched once over REST (`GET /api/messages`, last 50, returned oldest→newest); live messages arrive over the socket. The client emits `new_message`; the server inserts into Postgres and `io.emit`s `message` to **all** clients including the sender (no optimistic UI — the sender renders its own message from the broadcast). REST and socket payloads both use the same camelCase shape `{ id, userId, username, content, createdAt }`; keep them in sync if either changes.

**Socket events:**
- client → server: `new_message { content }`, `typing`
- server → client: `message`, `online_count` (from `io.sockets.sockets.size`), `user_typing` / `user_stop_typing` (username string), `error { message }`

Typing is debounced server-side: a per-user timer map broadcasts `user_typing` once per burst and `user_stop_typing` after 3s of silence or on disconnect.

**Socket lifecycle:** `client/src/socket.js` is a singleton with `autoConnect: false`. `client/src/pages/Chat.jsx` calls `socket.connect()` on mount, registers listeners, and `off`s them + disconnects on unmount; a `connect_error` (e.g. expired token) logs the user out. Add new listeners inside that same effect and remove them in its cleanup.

**Routing** (`client/src/App.jsx`): `/` Landing, `/login` and `/signup` wrapped in `GuestRoute` (redirects authed users to `/chat`), `/chat` wrapped in `ProtectedRoute` (redirects to `/login`).
