// server/scripts/seedDemo.ts
// `npm run seed:demo`: the demo data a visitor finds (docs/phase-3-implementation-plan.md §7):
// the demo account, whose credentials the login page fills in, a few demo users, channels
// with a short conversation, a private channel and a DM. Run it after `npm run migrate`,
// against the database in DATABASE_URL (the root .env's, or one given on the command line).
//
// Idempotent: users, channels and memberships are created only when missing, and a
// conversation's messages only while it has none, so running it again changes nothing.
// It refuses to run if one of its usernames belongs to someone else, so it never posts as
// a real user. Everything happens in one transaction: a failure leaves nothing half-made.
import bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { pathToFileURL } from 'url';
import pool from '../db/connection.js';
import { withTransaction, type Queryable } from '../db/transaction.js';
import { logger } from '../lib/logger.js';
import {
  addMember,
  allocateSeq,
  createChannel,
  createDirectConversation,
  findDirectConversationId,
  findGeneralId,
  markRead,
  type Role,
} from '../repositories/conversations.js';
import { createMessage } from '../repositories/messages.js';
import { createUser } from '../repositories/users.js';

/** The account anyone may use. The client fills these in (client/src/lib/demo.ts): keep both in step. */
export const DEMO_ACCOUNT = Object.freeze({
  username: 'demo',
  displayName: 'Demo',
  email: 'demo@example.com',
  password: 'relay-demo',
});

// The people the demo account chats with. Nobody can log in as them: their passwords
// are random and thrown away.
const PEOPLE = ['maya', 'sam', 'priya', 'leo'].map((username) => ({
  username,
  displayName: username[0].toUpperCase() + username.slice(1),
  email: `${username}@demo.example.com`,
}));

const SALT_ROUNDS = 10; // as signup (routes/auth.js)

// How far apart the seeded messages of a conversation are, the last one just now.
const MESSAGE_SPACING_MINUTES = 3;

type Script = readonly (readonly [author: string, content: string])[];

interface ChannelSeed {
  name: string;
  topic: string;
  visibility: 'public' | 'private';
  /** The first is its creator and owner. */
  members: readonly string[];
  messages: Script;
}

const everyone = ['maya', 'sam', 'priya', 'leo', 'demo'] as const;

const CHANNELS: readonly ChannelSeed[] = [
  {
    name: 'general',
    topic: 'Everyone lands here. Say hi!',
    visibility: 'public',
    members: everyone,
    messages: [
      ['maya', 'Welcome to Relay! 👋 This is #general: everyone joins it at signup.'],
      ['sam', 'Tip: open a second browser window, sign up as someone else, and chat with yourself. Messages arrive instantly.'],
      ['priya', 'Typing indicators work too. Start typing in one window and watch the other.'],
      ['leo', 'More channels are in the sidebar. "Browse channels" finds public ones, and "+" creates your own.'],
    ],
  },
  {
    name: 'random',
    topic: 'Off-topic, links and everything else',
    visibility: 'public',
    members: ['sam', 'priya', 'leo', 'maya', 'demo'],
    messages: [
      ['sam', 'Anyone else drinking far too much coffee this week? ☕'],
      ['priya', 'Guilty.'],
      ['leo', 'Tea, checking in. 🍵'],
    ],
  },
  {
    name: 'engineering',
    topic: 'How Relay works',
    visibility: 'public',
    members: ['leo', 'maya', 'priya', 'demo'],
    messages: [
      ['maya', 'Quick tour: when you send a message, the server numbers it inside a transaction, one sequence per conversation.'],
      ['leo', 'So everyone sees the same order, with no gaps, even when people send at the same moment.'],
      ['priya', 'Sessions live on the server, in an httpOnly cookie. Logging out also cuts off that session\'s live connection.'],
      ['leo', 'And a channel you are not in never reaches your browser: each conversation has its own socket room.'],
    ],
  },
  {
    name: 'launch-plans',
    topic: 'Private: only people the owner adds can see it',
    visibility: 'private',
    members: ['demo', 'maya', 'sam'],
    messages: [
      ['maya', 'This channel is private: nobody else can see it or find it.'],
      ['sam', 'Its owner adds people by username, with "Add people" at the top.'],
    ],
  },
];

// A DM with the demo account.
const DM: { with: string; messages: Script } = {
  with: 'maya',
  messages: [['maya', 'Hi! This is a direct message. Start one with anyone from "New message" in the sidebar.']],
};

export interface SeedReport {
  usersCreated: number;
  conversationsCreated: number;
  messagesCreated: number;
}

/** Creates whatever of the demo data is missing, in one transaction. */
export async function seedDemo(): Promise<SeedReport> {
  return withTransaction(async (db) => {
    const report: SeedReport = { usersCreated: 0, conversationsCreated: 0, messagesCreated: 0 };

    const userIds = new Map<string, number>();
    for (const person of [...PEOPLE, DEMO_ACCOUNT]) {
      const { id, created } = await ensureUser(db, person);
      userIds.set(person.username, id);
      if (created) report.usersCreated += 1;
    }
    const idOf = (username: string) => userIds.get(username)!;

    for (const channel of CHANNELS) {
      const { id, created } = await ensureChannel(db, channel, idOf);
      if (created) report.conversationsCreated += 1;
      for (const [i, username] of channel.members.entries()) {
        await ensureMember(db, id, idOf(username), i === 0 ? 'owner' : 'member');
      }
      report.messagesCreated += await ensureMessages(db, id, channel.messages, idOf);
    }

    const [userA, userB] = [idOf(DM.with), idOf(DEMO_ACCOUNT.username)].sort((a, b) => a - b);
    let dmId = await findDirectConversationId(db, userA, userB);
    if (dmId === undefined) {
      dmId = (await createDirectConversation(db, { userA, userB, createdBy: idOf(DM.with) }))!;
      report.conversationsCreated += 1;
    }
    await ensureMember(db, dmId, userA, 'member');
    await ensureMember(db, dmId, userB, 'member');
    report.messagesCreated += await ensureMessages(db, dmId, DM.messages, idOf);

    return report;
  });
}

async function ensureUser(
  db: Queryable,
  person: { username: string; displayName: string; email: string; password?: string },
): Promise<{ id: number; created: boolean }> {
  const { rows } = await db.query<{ id: number; email: string }>('SELECT id, email FROM users WHERE username = $1', [
    person.username,
  ]);
  if (rows[0]) {
    if (rows[0].email !== person.email) {
      throw new Error(`The username "${person.username}" belongs to someone else: the demo would post as them.`);
    }
    return { id: rows[0].id, created: false };
  }
  const passwordHash = await bcrypt.hash(person.password ?? randomBytes(32).toString('hex'), SALT_ROUNDS);
  const user = await createUser(db, { ...person, passwordHash });
  return { id: user.id, created: true };
}

/** A public channel by its name (unique among public ones); a private one by its name and creator. */
async function ensureChannel(
  db: Queryable,
  channel: ChannelSeed,
  idOf: (username: string) => number,
): Promise<{ id: number; created: boolean }> {
  const creator = idOf(channel.members[0]);
  if (channel.name === 'general') return { id: await findGeneralId(db), created: false };

  const { rows } = await db.query<{ id: number }>(
    `SELECT id FROM conversations
     WHERE type = 'channel' AND name = $1 AND visibility = $2 AND (visibility = 'public' OR created_by = $3)`,
    [channel.name, channel.visibility, creator],
  );
  if (rows[0]) return { id: rows[0].id, created: false };
  const id = await createChannel(db, { name: channel.name, topic: channel.topic, visibility: channel.visibility, createdBy: creator });
  return { id, created: true };
}

/** A membership, as if made a day ago, so the seeded messages are newer than it. */
async function ensureMember(db: Queryable, conversationId: number, userId: number, role: Role): Promise<void> {
  if (await addMember(db, conversationId, userId, role)) {
    await db.query(
      `UPDATE conversation_members SET joined_at = now() - interval '1 day' WHERE conversation_id = $1 AND user_id = $2`,
      [conversationId, userId],
    );
  }
}

/**
 * The conversation's messages, sent as the socket sends them (a seq each, the membership
 * checked, the author's read position moved), only while it has none; then spaced a few
 * minutes apart, the last one now. Returns how many it created. #general's topic is set
 * here too, while it has none.
 */
async function ensureMessages(
  db: Queryable,
  conversationId: number,
  script: Script,
  idOf: (username: string) => number,
): Promise<number> {
  const { rows } = await db.query<{ last_seq: number; name: string | null }>(
    'SELECT last_seq, name FROM conversations WHERE id = $1',
    [conversationId],
  );
  if (rows[0].last_seq > 0) return 0;
  if (rows[0].name === 'general') {
    const topic = CHANNELS.find((c) => c.name === 'general')!.topic;
    await db.query('UPDATE conversations SET topic = $2 WHERE id = $1 AND topic IS NULL', [conversationId, topic]);
  }

  for (const [author, content] of script) {
    const seq = (await allocateSeq(db, conversationId))!;
    const message = await createMessage(db, { conversationId, seq, authorId: idOf(author), content });
    if (!message) throw new Error(`${author} is not a member of conversation ${conversationId}`);
    await markRead(db, conversationId, idOf(author), seq);
  }
  await db.query(
    `UPDATE messages SET created_at = now() - (($2 - seq) * $3) * interval '1 minute' WHERE conversation_id = $1`,
    [conversationId, script.length, MESSAGE_SPACING_MINUTES],
  );
  return script.length;
}

// Run as a script (npm run seed:demo), not when imported by a test.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  seedDemo()
    .then((report) => logger.info(report, 'Demo data ready'))
    .catch((err) => {
      logger.error({ err }, 'Seeding the demo data failed');
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
