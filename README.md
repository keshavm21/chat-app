<div align="center">

# Relay

**A full-stack real-time group chat app — JWT auth, live Socket.io messaging, and PostgreSQL history.**

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-20+-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![React](https://img.shields.io/badge/react-19-20232a?logo=react&logoColor=61dafb)](https://react.dev)
[![Socket.io](https://img.shields.io/badge/socket.io-4.x-010101?logo=socket.io)](https://socket.io)
[![PostgreSQL](https://img.shields.io/badge/postgresql-14+-4169e1?logo=postgresql&logoColor=white)](https://www.postgresql.org)

[Live Demo](https://relay-chat-app.vercel.app/) · [Report a Bug](https://github.com/skinnyduck21/chat-app/issues)

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

## Tech Stack

| Layer | Technology | Notes |
|---|---|---|
| Frontend | React 19 (Vite) | SPA with fast HMR dev experience |
| Styling | Tailwind CSS v3 | Utility-first; rapid, consistent UI |
| Backend | Node.js + Express 5 | Lightweight REST API, ESM throughout |
| Real-time | Socket.io 4.x | WebSocket abstraction with fallback transport |
| Auth | JWT + bcrypt | Stateless; token verified on HTTP and WebSocket layers |
| Database | PostgreSQL (Neon) | Serverless Postgres with connection pooling |
| Deployment | Render + Vercel | Render for the Express server; Vercel for the React frontend |

---

## Project Structure

```
relay/
├── client/                          ← React frontend (Vite)
│   └── src/
│       ├── api/axios.js             — Axios instance with JWT interceptor
│       ├── components/              — ProtectedRoute, GuestRoute
│       ├── context/AuthContext.jsx  — Token + user state (localStorage)
│       ├── pages/                   — Landing, Login, Signup, Chat
│       ├── socket.js                — Socket.io singleton (autoConnect: false)
│       └── App.jsx                  — React Router route definitions
└── server/                          ← Express backend
    ├── db/connection.js             — PostgreSQL connection pool
    ├── middleware/verifyToken.js    — JWT verification middleware
    ├── routes/auth.js               — POST /api/auth/signup, /login
    ├── routes/messages.js           — GET /api/messages (last 50, protected)
    ├── socket/socketHandler.js      — Socket.io event handlers
    └── index.js                     — HTTP server + Socket.io bootstrap
```

---

## Local Setup

### Prerequisites

- Node.js 20+
- PostgreSQL 14+

### 1. Clone and install

```bash
git clone https://github.com/skinnyduck21/chat-app.git
cd relay-chat

cd server && npm install
cd ../client && npm install
```

### 2. Create the database

```sql
CREATE DATABASE relay;
\c relay

CREATE TABLE users (
  id         SERIAL PRIMARY KEY,
  username   VARCHAR(50)  NOT NULL UNIQUE,
  email      VARCHAR(100) NOT NULL UNIQUE,
  password   VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE messages (
  id         SERIAL PRIMARY KEY,
  user_id    INT REFERENCES users(id),
  username   VARCHAR(50),
  content    TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);
```

### 3. Environment variables

Create `.env` in the **project root** (next to `client/` and `server/`):

```env
# Database
DB_USER=postgres
DB_HOST=localhost
DB_NAME=relay
DB_PASSWORD=yourpassword
DB_PORT=5432

# Auth
JWT_SECRET=replace-with-a-long-random-string

# Server
PORT=5001
CLIENT_URL=http://localhost:5173
```

Create `client/.env.local`:

```env
VITE_API_URL=http://localhost:5001
```

> **Note:** `client/src/api/axios.js` falls back to port `5000` if `VITE_API_URL` is not set, but the server runs on `5001`. Always set this variable — or update the fallback in `axios.js` to `http://localhost:5001`.

### 4. Run

```bash
# Terminal 1 — server
cd server && node index.js

# Terminal 2 — client
cd client && npm run dev
```

Open [http://localhost:5173](http://localhost:5173). Open a second browser tab to see real-time messaging in action.

---

## Deployment

### Neon — PostgreSQL database

1. Create a free project at [neon.tech](https://neon.tech).
2. Copy the **connection string** from the Neon dashboard (it looks like `postgresql://user:pass@host/dbname?sslmode=require`).
3. Run the `CREATE TABLE` SQL above in the Neon SQL editor.
4. Use this connection string as `DATABASE_URL` in your Render environment variables (see below).

Update `server/db/connection.js` to support `DATABASE_URL` before deploying:

```js
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    })
  : new Pool({
      user:     process.env.DB_USER,
      host:     process.env.DB_HOST,
      database: process.env.DB_NAME,
      password: process.env.DB_PASSWORD,
      port:     process.env.DB_PORT,
    });
```

This keeps local development working while supporting Neon's `DATABASE_URL` in production.

### Render — Express server

1. Push the repo to GitHub.
2. In [Render](https://render.com): **New** → **Web Service** → connect your GitHub repo.
3. Set the **Root Directory** to `server/`.
4. Build command: `npm install` · Start command: `node index.js`.
5. Add environment variables in the Render dashboard:

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | your Neon connection string |
   | `JWT_SECRET` | a long random string |
   | `CLIENT_URL` | your Vercel frontend URL (from the step below) |

6. Note your Render server URL (e.g. `https://relay-server.onrender.com`).

### Vercel — React frontend

1. Import the `client/` folder as a new Vercel project.
2. Set the environment variable:

   | Variable | Value |
   |---|---|
   | `VITE_API_URL` | `https://relay-server.onrender.com` |

3. Build command: `npm run build` · Output directory: `dist`.
4. Copy the Vercel URL back into Render's `CLIENT_URL` variable and redeploy.

---

## How It Works

### Authentication

1. User signs up → server hashes the password with bcrypt and returns a signed JWT
2. React stores the token in `localStorage`; an Axios interceptor attaches it as `Authorization: Bearer <token>` on every outgoing request
3. Express `verifyToken` middleware validates the token on all protected HTTP routes
4. Socket.io verifies the same token during the WebSocket handshake — invalid tokens are rejected before the connection is established

### Real-time messaging

1. On mounting `/chat`, the client calls `socket.connect()` with the JWT in the auth payload
2. The user sends a message → client emits `new_message`
3. Server inserts the row into PostgreSQL, then broadcasts the complete message object to all connected clients
4. Every open browser receives the `message` event and appends it to the list — no refresh, no polling

### Typing indicators

1. Client emits a `typing` event on each keystroke
2. Server broadcasts `user_typing` to all other clients on the first event of a burst, then starts a 3-second auto-clear timer
3. After 3 seconds of silence, server broadcasts `user_stop_typing`
4. On disconnect, the server immediately clears any in-progress typing state for that user

---

## License

MIT — see [LICENSE](./LICENSE) for details.