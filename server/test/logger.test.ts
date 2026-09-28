import { describe, expect, it } from 'vitest';
import { Writable } from 'stream';
import express from 'express';
import pino from 'pino';
import { pinoHttp } from 'pino-http';
import request from 'supertest';
import { httpLoggerOptions, loggerOptions } from '../lib/logger.js';

/** A logger with the app's real options (at level info) whose JSON lines are captured. */
function capturingLogger() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      lines.push(...chunk.toString().split('\n').filter(Boolean));
      done();
    },
  });
  return { logger: pino({ ...loggerOptions, level: 'info' }, stream), lines };
}

describe('logger redaction', () => {
  it('logs each request as JSON without the Authorization header, cookies or passwords', async () => {
    const { logger, lines } = capturingLogger();
    const app = express();
    app.use(pinoHttp({ logger }));
    app.use(express.json());
    app.post('/api/auth/login', (req, res) => {
      // Even if code logs a request body by mistake, the password is hidden.
      req.log.info({ body: req.body }, 'login attempt');
      res.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' } });
    });

    await request(app)
      .post('/api/auth/login')
      .set('Authorization', 'Bearer eyJ-SECRET-TOKEN')
      .set('Cookie', 'session=SECRET-COOKIE')
      .send({ email: 'a@example.test', password: 'SECRET-PASSWORD' });

    const output = lines.join('\n');
    expect(output).not.toMatch(/SECRET-(TOKEN|COOKIE|PASSWORD)/);

    const entries = lines.map((line) => JSON.parse(line)); // every line is valid JSON
    const completed = entries.find((e) => e.msg === 'request completed');
    expect(completed).toMatchObject({
      req: { method: 'POST', url: '/api/auth/login', headers: { authorization: '[Redacted]', cookie: '[Redacted]' } },
      res: { statusCode: 401 },
    });
    expect(entries.find((e) => e.msg === 'login attempt')?.body.password).toBe('[Redacted]');
  });

  it('hides the Set-Cookie response header, which carries the session token', async () => {
    const { logger, lines } = capturingLogger();
    const app = express();
    app.use(pinoHttp({ logger }));
    app.post('/api/auth/login', (_req, res) => {
      res.cookie('relay_session', 'SECRET-SESSION-TOKEN', { httpOnly: true, sameSite: 'lax' });
      res.json({ user: { id: 1 } });
    });

    await request(app).post('/api/auth/login').send({});

    expect(lines.join('\n')).not.toContain('SECRET-SESSION-TOKEN');
    const completed = lines.map((line) => JSON.parse(line)).find((e) => e.msg === 'request completed');
    expect(completed.res.headers['set-cookie']).toBe('[Redacted]');
  });

  // The release checks TRUST_PROXY in these lines (plan §15, step 6).
  it.each([
    [0, '::ffff:127.0.0.1'], // the socket's address: the header is ignored
    [1, '203.0.113.7'], // the address the one trusted proxy appended
  ])('logs the client IP as Express sees it, with trust proxy %s', async (trustProxy, ip) => {
    const { logger, lines } = capturingLogger();
    const app = express();
    app.set('trust proxy', trustProxy);
    app.use(pinoHttp({ logger, ...httpLoggerOptions }));
    app.get('/api/ping', (_req, res) => {
      res.json({ ok: true });
    });

    await request(app).get('/api/ping').set('X-Forwarded-For', '203.0.113.7');

    const completed = lines.map((line) => JSON.parse(line)).find((e) => e.msg === 'request completed');
    expect(completed.ip).toBe(ip);
  });

  it('hides a Postgres error DETAIL, which can contain row values, but keeps the message', () => {
    const { logger, lines } = capturingLogger();
    const pgError = Object.assign(new Error('new row for relation "users" violates check constraint'), {
      code: '23514',
      detail: 'Failing row contains (1, alice, a@example.test, $2b$10$SECRET-HASH).',
    });

    logger.error({ err: pgError }, 'Signup error');

    const [entry] = lines.map((line) => JSON.parse(line));
    expect(entry.err).toMatchObject({ message: pgError.message, code: '23514', detail: '[Redacted]' });
    expect(lines.join('\n')).not.toContain('SECRET-HASH');
  });

  it('hides the pg client that pg-pool attaches to pool errors (it contains the DB password)', () => {
    const { logger, lines } = capturingLogger();
    const poolError = Object.assign(new Error('terminating connection due to administrator command'), {
      code: '57P01',
      client: { password: 'SECRET-DB-PASSWORD', connectionParameters: { password: 'SECRET-DB-PASSWORD' } },
    });

    logger.error({ err: poolError }, 'Idle database client error');

    const [entry] = lines.map((line) => JSON.parse(line));
    expect(entry.err).toMatchObject({ code: '57P01', client: '[Redacted]' });
    expect(lines.join('\n')).not.toContain('SECRET-DB-PASSWORD');
  });
});
