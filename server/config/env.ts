// server/config/env.ts
// The only place the server reads process.env. Everything else imports `config`.
import dotenv from 'dotenv';
import pino from 'pino';
import { fileURLToPath } from 'url';
import { basename, dirname, resolve } from 'path';
import { z } from 'zod';

// ── .env loading ───────────────────────────────────────────────────────────────
// Loads the repo-root .env before parsing. Variables that are already set (Render,
// CI, tests) are never overridden.
const here = dirname(fileURLToPath(import.meta.url));
// The compiled build runs from server/dist/config/, one level deeper than the source.
const rootEnv = basename(dirname(here)) === 'dist' ? '../../../.env' : '../../.env';
// quiet: dotenv would otherwise print its own non-JSON banner into the log stream.
dotenv.config({ path: resolve(here, rootEnv), quiet: true });

// ── Schema ─────────────────────────────────────────────────────────────────────
// An empty value (e.g. `PORT=` in .env) is treated the same as an unset one.
const blankAsUnset = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema);

const port = z.coerce.number().int().min(1).max(65535);
const DB_VARS = ['DB_USER', 'DB_HOST', 'DB_NAME', 'DB_PASSWORD'] as const;

// Hosts that need no TLS: the local Docker database ('' is a Unix socket).
const LOCAL_DB_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '']);

/**
 * What is wrong with a DATABASE_URL, if anything. A database that is not local must say
 * sslmode=verify-full, so the connection checks the server's certificate and host name
 * (pg treats sslmode=require the same today, but has announced that it will stop).
 */
function databaseUrlProblem(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'Must be a connection URL, e.g. postgres://user:password@host/database';
  }
  if (LOCAL_DB_HOSTS.has(parsed.hostname)) return undefined;
  if (parsed.searchParams.get('sslmode') !== 'verify-full') {
    return 'A database that is not local must use sslmode=verify-full';
  }
  return undefined;
}

const schema = z
  .object({
    NODE_ENV:     blankAsUnset(z.enum(['development', 'production', 'test']).default('development')),
    PORT:         blankAsUnset(port.default(5001)),
    CLIENT_URL:   blankAsUnset(z.url().default('http://localhost:5173')),
    DATABASE_URL: blankAsUnset(z.string().optional()),
    DB_USER:      blankAsUnset(z.string().optional()),
    DB_HOST:      blankAsUnset(z.string().optional()),
    DB_NAME:      blankAsUnset(z.string().optional()),
    DB_PASSWORD:  blankAsUnset(z.string().optional()),
    DB_PORT:      blankAsUnset(port.default(5432)),
    LOG_LEVEL:    blankAsUnset(z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info')),
    // How many proxies in front of the server to trust for X-Forwarded-For (Express's
    // `trust proxy`): 0 trusts none, so a client cannot choose its own IP.
    TRUST_PROXY:  blankAsUnset(z.coerce.number().int().min(0).default(0)),
  })
  .superRefine((env, ctx) => {
    // DATABASE_URL takes precedence; otherwise every DB_* connection variable is needed.
    if (env.DATABASE_URL) {
      const problem = databaseUrlProblem(env.DATABASE_URL);
      if (problem) ctx.addIssue({ code: 'custom', path: ['DATABASE_URL'], message: problem });
      return;
    }
    const missing = DB_VARS.filter((name) => !env[name]);
    if (missing.length === DB_VARS.length) {
      ctx.addIssue({ code: 'custom', path: ['DATABASE_URL'], message: `Required (or set ${DB_VARS.join(', ')})` });
    } else {
      for (const name of missing) {
        ctx.addIssue({ code: 'custom', path: [name], message: 'Required when DATABASE_URL is not set' });
      }
    }
  });

export class ConfigError extends Error {
  constructor(readonly variables: string[], readonly issues: string[]) {
    super(`Invalid environment configuration (values are not shown):\n${issues.map((d) => `  - ${d}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/** Validates an environment object and returns the frozen config, or throws ConfigError. */
export function parseEnv(env: Record<string, string | undefined>) {
  const result = schema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({ name: String(issue.path[0]), message: issue.message }));
    throw new ConfigError(
      [...new Set(issues.map((i) => i.name))],
      issues.map((i) => `${i.name}: ${i.message}`),
    );
  }

  const e = result.data;
  return Object.freeze({
    nodeEnv:   e.NODE_ENV,
    port:      e.PORT,
    clientUrl: e.CLIENT_URL,
    logLevel:  e.LOG_LEVEL,
    trustProxy: e.TRUST_PROXY,
    // `url` wins when set; the DB_* fields are then unused (same precedence as before).
    database: Object.freeze({
      url:      e.DATABASE_URL,
      user:     e.DB_USER,
      host:     e.DB_HOST,
      name:     e.DB_NAME,
      password: e.DB_PASSWORD,
      port:     e.DB_PORT,
    }),
  });
}

export type Config = ReturnType<typeof parseEnv>;

function loadConfig(): Config {
  try {
    return parseEnv(process.env);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    // Fail fast, before the server connects to anything or listens. The app's logger
    // (lib/logger.ts) takes its level from this config, so it cannot exist yet: use a
    // default pino instance. pino flushes on process exit, so the line is not lost.
    pino().fatal(
      { variables: err.variables, issues: err.issues },
      'Invalid environment configuration (values are not shown)',
    );
    process.exit(1);
  }
}

export const config = loadConfig();
