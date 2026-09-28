import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'url';
import request from 'supertest';
import { startServer, type TestServer } from './helpers.js';

// Express serves the built client (topology A, docs/phase-2-implementation-plan.md §11),
// here a small fixture build, so these tests need no client build.

const FIXTURE_DIST = fileURLToPath(new URL('./fixtures/client-dist', import.meta.url));

let server: TestServer;

beforeAll(async () => {
  server = await startServer({ clientDist: FIXTURE_DIST });
});

afterAll(async () => {
  await server.close();
});

describe('serving the client', () => {
  it.each(['/', '/chat', '/login', '/signup', '/no/such/page'])('answers %s with index.html, never cached', async (path) => {
    const res = await request(server.httpServer).get(path);

    expect(res.status).toBe(200);
    expect(res.get('Content-Type')).toMatch(/^text\/html/);
    expect(res.text).toContain('<title>relay-test-fixture</title>');
    expect(res.get('Cache-Control')).toBe('no-cache');
    // helmet's headers reach the page too.
    expect(res.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.get('X-Powered-By')).toBeUndefined();
  });

  it('serves hashed assets with a year-long, immutable cache', async () => {
    const res = await request(server.httpServer).get('/assets/index-Test1234.js');

    expect(res.status).toBe(200);
    expect(res.get('Content-Type')).toMatch(/^text\/javascript/);
    expect(res.text).toContain('relay-test-asset');
    expect(res.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
  });

  it('answers a missing asset with 404, not with index.html', async () => {
    const res = await request(server.httpServer).get('/assets/index-Gone9999.js');

    expect(res.status).toBe(404);
    expect(res.text).not.toContain('relay-test-fixture');
  });

  it('serves the other top-level files of the build', async () => {
    const res = await request(server.httpServer).get('/favicon.svg');

    expect(res.status).toBe(200);
    expect(res.get('Content-Type')).toMatch(/^image\/svg\+xml/);
  });

  it('keeps the JSON 404 for unknown /api routes', async () => {
    for (const path of ['/api', '/api/unknown', '/api/auth/unknown']) {
      const res = await request(server.httpServer).get(path);

      expect(res.status, path).toBe(404);
      expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Route not found.' } });
    }
  });

  it('keeps the API working next to the client', async () => {
    const res = await request(server.httpServer).get('/api/ping');

    expect(res.body).toEqual({ message: 'Server is alive' });
  });
});

describe('without a client build', () => {
  it('serves only the API', async () => {
    const apiOnly = await startServer({ clientDist: fileURLToPath(new URL('./fixtures/no-such-dist', import.meta.url)) });
    try {
      expect((await request(apiOnly.httpServer).get('/chat')).status).toBe(404);
      expect((await request(apiOnly.httpServer).get('/api/ping')).status).toBe(200);
    } finally {
      await apiOnly.close();
    }
  });
});
