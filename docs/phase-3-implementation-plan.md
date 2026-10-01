# Relay — Phase 3 Implementation Plan: channels, DMs and launch

**Status:** ✅ **Approved** (2026-09-30), with the maintainer's decisions in [§9](#9-decisions-confirmed-at-approval). **Complete and released** (2026-10-01): M0–M3 done and approved, released with Phase 2 from a fresh database — see [§8](#8-release-phases-2-and-3-together) for the release record, [§10 Progress record](#10-progress-record) and [§11 Completion record](#11-completion-record).
**Scope source:** `docs/v2-design.md` §9 (Phases 3, 4 and 8), cut down to the visible features, as the maintainer decided on 2026-09-30: the visible features come first, and the work should be finished quickly. The handoff is `docs/phase-2-implementation-plan.md` §18.
**Rule:** if a step seems to need something not listed here, stop and ask. Do not expand the scope.

---

## 1. Goal

Turn the single-room chat into a small multi-conversation app that a visitor can open and use at once, then release it together with Phase 2:

- **Public channels:** browse, create, join and leave; `#general` stays the default everyone joins at signup.
- **Private channels, minimal** (built last, dropped if it grows; §9, decision 4): the creator adds people by username; nobody else can see or find the channel.
- **Direct messages:** start a 1:1 conversation with any user, found by username.
- **Messaging in each conversation:** a sidebar of my conversations, history per conversation with "load older", live messages and typing only to that conversation's members, and unread counts in the sidebar.
- **Launch:** a demo account and seeded channels so the app is not empty for a visitor, updated README, and **one release** of Phases 2 and 3 to production.

**Done when:** a stranger can open the live site, log in with the demo account (or sign up), switch between channels and DMs, and chat in real time, and every server rule has a test.

---

## 2. What this plan leaves out

The design's Phases 5–7 and most of Phase 8 are **not** built. They add depth, not visible features.

| Left out | Design phase | Why it can go |
|---|---|---|
| Roles beyond owner, moderation, removing members | 3, 7 | Needs the full permission matrix; private channels come in their minimal form (§5) |
| Message editing and deletion | 7 | Needs the change feed (`rev`) to reach offline clients correctly |
| REST send with `clientId` retry, pending/failed states | 4 | The socket send already has gapless ordering and tests; retry is invisible in a demo |
| Catch-up sync, gap detection, protocol-version handshake | 5 | A reconnect reloads the open conversation's latest page instead (the design's "simplified" level, §5) |
| Presence per user; cross-tab read sync | 6 | The global "N online" count stays |
| Strict TypeScript, CSP, load script, search, session UI | 8, later | Not visible |

---

## 3. Decisions this plan implements

| # | Decision | How |
|---|---|---|
| 1 | **Visible features only** (maintainer, 2026-09-30) | §1 and §2 |
| 2 | **Messages are still sent over the socket** (a change from D2's REST writes; §9, question 1) | `new_message { conversationId, content }`, using the Phase 1 send transaction, which already takes any conversation and checks membership in the insert |
| 3 | **Reading needs membership** (D14), and conversations a user is not in answer 404, not 403 | One `requireMember` check in the conversation routes |
| 4 | **Socket rooms per conversation** (design §5) | Each socket joins `conv:<id>` for every membership on connect and `user:<id>`; joining, leaving and new DMs add or remove the user's sockets live (`socketsJoin`/`socketsLeave`) |
| 5 | **No service or policy layer yet** (a simplification of the design's §3) | Routes call repositories; the only rule is membership |
| 6 | **One release at the end** | Phase 2 and Phase 3 go to production together (§8) |

---

## 4. Milestones

| Milestone | Delivers |
|---|---|
| **M0 — Branch** | `phase-3` from `phase-2`, a draft PR `phase-3 → main` (which also carries Phase 2), Vercel deployments of the branch off, green CI |
| **M1 — Conversations on the server** | The REST API and socket rooms of §5, the single-room API removed, tests |
| **M2 — Conversations in the client** | Routing, sidebar, conversation view, channel browser, new channel, new DM, unread badges, load older |
| **M3 — Launch** | Demo account and seed data, landing and README, fresh-clone check, completion record |
| **Release** | §8 |

Each milestone ends with the app working locally and CI green, and starts after the maintainer approves the previous one.

---

## 5. M1 — Conversations on the server

**REST API** (all need a session; bodies are JSON, as today)

| Endpoint | Does |
|---|---|
| `GET /api/conversations` | My channels and DMs: id, type, name (the other user's name for a DM), `lastSeq`, `lastReadSeq`, `unreadCount = lastSeq - lastReadSeq`, `lastMessageAt`; sorted by last activity |
| `GET /api/channels?q=` | Public channels, with whether I am a member; optional name prefix |
| `POST /api/channels {name, topic?}` | Creates a public channel (name rules already in the schema: `^[a-z0-9-]{1,40}$`); the creator is its owner and first member; 409 if the name is taken |
| `POST /api/conversations/:id/join` / `…/leave` | Join or leave a public channel; `#general` cannot be left |
| `GET /api/users?q=` | Up to 10 users by username prefix (for starting a DM); rate limited |
| `POST /api/dms {userId}` | Get or create the DM with that user: idempotent, and two concurrent requests create one conversation (`INSERT … ON CONFLICT` on the pair) |
| `POST /api/channels {…, visibility: 'private'}`, `POST /api/conversations/:id/members {username}` | *Last, and only while small:* a private channel, and its owner adding a member; not listed by `GET /api/channels`, 404 to non-members, not joinable |
| `GET /api/conversations/:id/messages?before=<seq>&limit=50` | History, newest page first by default, keyset-paginated by `seq`; 404 for non-members |
| `PUT /api/conversations/:id/read {seq}` | Moves my read position forward only (`GREATEST`), for unread counts |

**Socket**
- On connect: join `user:<id>` and `conv:<id>` for each membership (one query).
- `new_message { conversationId, content }`: the existing send transaction for that conversation; a non-member gets the existing `error`; the broadcast goes to `conv:<id>` only, not to everyone.
- `typing { conversationId }` → `user_typing { conversationId, username }` to that room only.
- Joining, leaving and a new DM update the user's sockets' rooms at once, and `conversation:joined` / `conversation:left` tell the user's other tabs to update their sidebar.
- `online_count` stays global.

**Removed:** `GET /api/messages` and the single-room broadcast.

**Tests:** each endpoint's happy path and errors; non-members get 404 and receive no socket events from that conversation; the concurrent DM race creates one conversation; `#general` cannot be left; pagination edges (empty, exact page, older pages); read position never moves back; existing session, CSRF and rate-limit tests keep passing.

---

## 6. M2 — Conversations in the client

- Routes: `/chat` redirects to the last open conversation (or `#general`); `/c/:conversationId` shows one.
- `Chat.jsx` splits into a sidebar (channels, DMs, unread badges, "Browse channels", "New channel", "New message"), a conversation header, the message list with "Load older", and the composer.
- A conversations context holds the sidebar list and unread counts; the open conversation's messages live in a reducer keyed by conversation.
- On reconnect, the open conversation reloads its latest page (no gaps, no duplicates: messages are merged by `id`).
- Dialogs: browse and join channels; create a channel (public, or private last); find a user and open a DM; for a private channel's owner, add people.
- Mobile: the sidebar collapses into a menu.

**Verification:** in headless Chrome, two users: create a channel, the other joins, messages and typing arrive only there; a DM between them; unread badges rise and clear; load older works; a user outside a channel sees nothing from it.

---

## 7. M3 — Launch

- **Demo data:** an idempotent `npm run seed:demo` (server) that creates a few channels with a short conversation between demo users, and a demo account. The login page gets a "Try the demo account" button that fills in its credentials. Anyone can post as the demo user; the existing rate limits apply.
- **Landing page and README:** the new features, screenshots, the live link.
- **Docs:** ADR for the reduced scope and the socket send (decisions 1–2), CLAUDE.md, `docs/v2-design.md` §9, completion record.
- **Fresh-clone check,** as in Phase 2.

---

## 8. Release (Phases 2 and 3 together)

The existing production data is not kept (maintainer, 2026-09-30), so the release starts from a clean database. The Neon password was reset on 2026-09-30 after it leaked; Render already uses the new one.

1. **Database:** reset the production database (or create a new one), then run `npm run migrate` against it with `sslmode=verify-full`, and `npm run seed:demo`.
2. **Render:** `DATABASE_URL` (verify-full), `CLIENT_URL=https://chat-app-7wix.onrender.com`, `NODE_ENV=production`, `TRUST_PROXY=3` (planned as 1; see the release record); root directory empty, the two-project build and start commands (Phase 2 plan §15, step 3); delete `JWT_SECRET`.
3. **Merge** the `phase-3` PR into `main` (and close PR #2, whose commits it contains). Render deploys; Vercel deploys the redirect.
4. **Smoke test** on the live site: demo login, a channel, a DM, two users in real time, logout in one tab sending the other to `/login`, `__Host-relay_session` in devtools, the old Vercel URL redirecting.
5. **Check `TRUST_PROXY`** in Render's logs (Phase 2 plan §15, step 6).
6. **Record** the release; delete `VITE_API_URL` from Vercel.

**Rollback:** revert the merge and restore the Render settings; with a fresh database, re-run the migrations.

**Release record (2026-10-01).**
1. The maintainer emptied the production database, ran `npm run migrate` (`0001`–`0004`) and `npm run seed:demo` against it with `sslmode=verify-full`, and saved Render's new settings (root directory empty, the two-project build and start commands, `CLIENT_URL`, `NODE_ENV=production`, `TRUST_PROXY=1`) without deploying.
2. PR #3 was merged into `main` (`c65bd2e`); PR #2 shows as merged too, since its commits came with #3.
3. **The first deploy failed:** `vite: not found`. Render runs the build with the service's `NODE_ENV=production`, so `npm ci` skipped the client's dev dependencies (the server's install already had `--include=dev`). The fresh-clone check had run Render's command without that variable. Fixed by adding `--include=dev` to the client's `npm ci` in Render's build command (and in the README and the Phase 2 plan's §15); the next deploy went live. The old Phase 1 deploy kept serving meanwhile.
4. **Smoke test on the live site** (headless Chrome, two throwaway accounts so the demo account and public channels stay clean): the landing page's "Try the demo" signs in to the seeded demo account; the session cookie is `__Host-relay_session` with `HttpOnly`, `Secure` and `SameSite=Lax`, and `document.cookie` does not show it; signup, and a reload staying logged in; a new DM appears live in the other user's sidebar. It also found a bug: **the client reconnected its socket at every change of conversation** (`useNavigate()` returns a new function after each navigation under `BrowserRouter`, and the socket effect depended on it), so a keystroke right after switching could miss its typing event on production's latency. Fixed by reading `navigate` through a ref; checked in headless Chrome: 7 switches opened 7 new sockets before the fix and none after.
5. **`TRUST_PROXY=1` was wrong for Render.** After the reconnect fix was deployed, the smoke test's 11th wrong password still got 401. Render's log lines showed why: a request passes through Cloudflare, Render's load balancer and a proxy on the instance (the socket comes from `::1`), and `X-Forwarded-For` reads `<client>, <Cloudflare>, <balancer>`, with both of the last two varying. With 1, `req.ip` was the balancer's `10.x` address, so failed logins spread over several counters, and unrelated clients behind one balancer shared one. `TRUST_PROXY=3` takes the IP Cloudflare saw, and a spoofed entry before it is ignored; `test/rateLimits.test.ts` replays the chain. The README, `.env.example` and CLAUDE.md say 3 now.
6. **After the reconnect fix** (deployed with `763c06c`), the rest of the smoke test passed on the live site: no socket reconnects over 8 changes of conversation, typing right after a switch arrives, a logout in one tab sends the other to `/login`, and the old Vercel URL answers 307 to the same path on Render.
7. **`TRUST_PROXY=3` set on Render and deployed:** ten wrong passwords for one email got 401 and the 11th got 429, even with a spoofed `X-Forwarded-For` on it, so the login limit counts each real client.
8. Left to finish: delete `JWT_SECRET` from Render and `VITE_API_URL` from Vercel (nothing reads them any more).

---

## 9. Decisions confirmed at approval

Confirmed by the maintainer on 2026-09-30.

| # | Question | Decision |
|---|---|---|
| 1 | **How messages are sent:** keep the socket send, or switch to REST with `clientId` retry (D2) | **Keep the socket send**, with `conversationId` added. |
| 2 | **Unread counts in the sidebar** | **Include.** |
| 3 | **What a visitor sees first** | **A demo login plus seeded channels.** |
| 4 | **Private channels** | **Include if it does not take long:** the minimal form in §1 and §5, built last in M1 and M2 and dropped if it grows. |

---

## 10. Progress record

| Milestone | State | Notes |
|---|---|---|
| M0 — Branch | Done 2026-09-30 | `phase-3` from `phase-2` (`06bdb9c`); draft PR #3 `phase-3 → main`; CI green; `client/vercel.json` turns off Vercel deployments of the branch (GitHub shows none). |
| M1 — Conversations on the server | Done 2026-10-01 (approved with the decisions below) | The REST API and rooms of §5; `GET /api/messages` and the global broadcast removed; the maintainer's four follow-up decisions (below); server tests 208 → 325, and 7 client unit tests. Details below. |
| M2 — Conversations in the client | Done 2026-10-01 (approved) | The §6 client, checked in headless Chrome as §6 asks; 28 client unit tests. Details below. |
| M3 — Launch | Done 2026-10-01 (approved) | Demo data and the demo login, landing page and README, ADR 0006, docs, the fresh-clone check. Details below and in §11. |

**Maintainer's decisions on M1** (2026-10-01):
1. **Private channel names cannot be found through a 409.** Migration `0004` makes names unique among public channels only; private channels may share a name with each other or with a public channel. `#general` is therefore looked up by name and `visibility = 'public'`.
2. **Members other than the owner can leave a private channel**, which ends their access at once (the membership row is deleted, then their sockets leave the room). The owner cannot leave (403); there is no ownership transfer. DMs still cannot be left.
3. **Channel creation is limited to 20 per user per hour** (in memory, like the other limits); only successful creations count. The demo account's visitors share this budget, which is why it is not smaller.
4. **A refused socket handshake is retried by the client** (`client/src/lib/reconnect.ts`: 1 s, doubling to 30 s, ±25 % jitter), so a brief database failure no longer leaves the tab offline until a reload. The client's first unit tests run under Node's own test runner (`npm test` in `client/`, a CI step), with no new dependency.

**M1 notes** (choices the plan left open, for the maintainer's review):
- **The client changed a little in M1** (`Chat.jsx` only): removing `GET /api/messages` would otherwise break the app until M2, and §4 wants it working at the end of each milestone. It shows `#general` through the new API; everything else waits for M2.
- **Summary fields beyond §5's list:** `visibility` (the private lock), `topic` (the header), `role` (the owner's "add people") and `lastActivityAt` (the sort key, so the client can keep the server's order).
- **Status codes:** non-members and missing or malformed ids get 404; leaving `#general` or a DM, the owner leaving a private channel, and adding members as anyone but a private channel's owner, get 403; a taken channel name 409; an existing DM 200, a new one 201.
- **Limits** (`lib/limits.ts`): topic ≤ 250 characters (checked in code only; the database has no topic constraint), history pages of 50 (at most 100), channel list ≤ 50, user search ≤ 10 results and 60 searches a minute per user and IP, 20 channels created per user per hour.
- **Typing** is now timed per socket and conversation, and never sent to the typist's own tabs.
- **Connect race closed:** a membership that changes while a socket is still connecting is caught by a change counter, and the socket looks its memberships up again (until no change happens during the lookup).
- **Not done (outside the plan):** message rate limits; zod schemas for socket payloads.
- **Known issues:** a NUL character in a message or a login email reaches Postgres and fails as a 500 or "Failed to save message." (both from before Phase 3).

**M2 notes:**
- **Structure** (D9, no new libraries): `ChatProvider` holds the list, the timelines (a reducer keyed by conversation), typing and the socket; the rules are pure functions in `client/src/lib/chatState.ts` with unit tests under `node --test`. The layout route keeps the socket and sidebar mounted while the conversation changes.
- **Sidebar:** channels (a lock for private ones) and DMs, each most recently active first, unread badges (none on the open conversation, which is marked read while the tab is visible), the online count, and "Browse channels", "New channel" and "New message". On narrow screens it is a drawer.
- **Header:** the name and topic; "Add people" for a private channel's owner; "Leave" wherever the server allows it (not `#general`, a DM, or my own private channel), after a confirmation.
- **Reconnect:** the list and the open conversation's latest page reload, merged by id; when the page does not connect to what is shown, what is older is dropped rather than left with a hole. Live messages that arrive while a page loads are kept.
- **`/chat`** reopens the conversation last open in this browser (per user), else `#general`.
- **Verified in headless Chrome** (three users): create a channel, another joins, messages and typing reach members only (the third user's socket received nothing of it); unread badges rise, clear, and stay cleared after a reload; a DM appears in the other user's sidebar with a badge; "Load older" pages back to seq 1; a private channel appears live when its owner adds someone, cannot be found by others, and can be left; the mobile drawer; a dropped connection catches up once, without duplicates; `/chat` reopens the last conversation; a refused handshake recovers without a reload. Found and fixed on the way: the typing indicator did not show in an empty conversation, and two sibling components with the same `key` left a stale message list on screen.
- **Not done (outside the plan):** cross-tab read sync (another tab's badge clears on its next reconnect or reload), a member list, notifications.

**M3 notes:**
- **Demo data:** `npm run seed:demo` (`server/scripts/seedDemo.ts`) creates the demo account (`demo@example.com` / `relay-demo`), four demo users nobody can log in as, `#random`, `#engineering`, a private `#launch-plans` owned by the demo account and a DM with it, each with a short conversation that explains a feature, and a topic for `#general`. One transaction; idempotent; it refuses to run if one of its usernames belongs to someone else, so it never posts as a real user. It is a TypeScript script run with `tsx`, like `npm run dev`, and stays out of the build.
- **Demo login:** "Try the demo account" on the login page fills in the credentials; the landing page's new "Try the demo" opens `/login?demo` with them filled in. The landing page also lists the features.
- **README:** rewritten for Phase 3: what to try first, new screenshots (landing, chat, mobile) taken from a freshly seeded database in production mode, features, status, structure, setup with the seed and the client tests, and how conversations, rooms and unread counts work. `docs/demo.gif` showed the old single-room app and is removed (no screen recorder was at hand to make a new one).
- **Found and fixed during the checks:** after someone sent a message, their next keystroke within 3 s did not show them typing again (clients clear the indicator on the message, while the server's burst went on). Sending now ends the burst; `rooms.test.ts` covers it.
- **Docs:** ADR 0006 (the reduced scope, the socket send and the simplified sync level), `docs/v2-design.md` §9 and next steps, CLAUDE.md, §11 below.

---

## 11. Completion record

Phase 3 was completed on 2026-10-01 on the `phase-3` branch, with draft PR #3 (`phase-3 → main`, which carries Phase 2 too) running CI on every push. Each milestone started after the maintainer approved the previous one; the maintainer reviewed the changes and made the commits, a feature commit and a docs commit per milestone. Server tests grew from 208 to 330; the client got its first tests (28, under Node's own test runner).

| Milestone | Commits | Notes |
|---|---|---|
| M0 — Branch | `06bdb9c` | Vercel deployments of `phase-3` off; draft PR #3. |
| M1 — Conversations on the server | `ecae495`, `87c3002` | The REST API, rooms and the maintainer's four follow-up decisions (§10): public-only name uniqueness (migration `0004`), leaving private channels, a channel-creation limit, the client's handshake retry. |
| M2 — Conversations in the client | `d70c066`, `d3f00d8` | Sidebar, conversation view, dialogs, unread badges, load older, reconnect catch-up, mobile drawer. |
| M3 — Launch | this milestone's commits | Demo data and login, landing page, README, ADR 0006, the fresh-clone check. |

**Fresh-clone verification (M3).** A fresh clone of `phase-3` (`d3f00d8`) with M3's changes applied, and a clean Docker volume under a separate Compose project (`relay-fresh`), so the maintainer's `relay_dev` was kept. Following the README: `npm install` in both projects; `docker compose up`; `.env` copied from `.env.example` unchanged; `npm run migrate` built the database from `0001`–`0004`; `0004` rolled back and re-applied; `npm run seed:demo` created 5 users, 4 conversations and 14 messages, and a second run created nothing; `npm test` migrated `relay_test` and passed 329 of 329 (330 with the typing fix found below); the client's 28 tests, and lint, typecheck and build in both projects, passed. The app, run with both `npm run dev`s through the Vite proxy, passed a smoke test in headless Chrome: the landing page's "Try the demo" signs in as the demo account, which finds the seeded channels, the private channel and the DM with unread badges; the login page's button fills the form; a new user and the demo account chat live in `#general`, typing included; opening a channel clears its badge. Render's build and start commands (§8, step 2; the Phase 2 plan's §15, step 3), run from the clone's root with `NODE_ENV=production`, built both projects and served the client: `/`, `/chat`, `/c/1` and `/login?demo` as `index.html` with `no-cache`, a missing asset as 404, `/api` JSON 404s; the same smoke test passed against it, the session cookie was `__Host-relay_session` with `HttpOnly`, `Secure` and `SameSite=Lax`, and the README's screenshots were taken there. That run found the typing bug above; after the fix, the clone was rebuilt and every check passed again.

**Production:** released 2026-10-01 (§8, release record): `main` is Phases 0–3, and the production database was created fresh by the maintainer.

**Known issues and notes**
- Everything in the Phase 2 plan's §17 still applies (`ws` advisories through Socket.io, the free tier's cold start, no long-polling fallback, the 5-minute sweep for sessions that end without a logout).
- The demo account is shared: one visitor's reads clear badges for the next, and anyone can post as it (the existing rate limits apply). Running `npm run seed:demo` again does not reset it.
- A send lost while the socket drops is not retried (ADR 0006); another tab's unread badges catch up on its next reconnect or reload (no cross-tab read sync).
- Channel names: private channels may share a name, so a user can see two `#plans` in their sidebar if they are in both.
- A NUL character in a message or a login email reaches Postgres and fails as "Failed to save message." or a 500 (both from before Phase 3).
- Socket payloads are checked by hand, not with zod; messages have no rate limit.

**Next:** the open items of the release record (§8).

