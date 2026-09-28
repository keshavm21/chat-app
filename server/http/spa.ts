// server/http/spa.ts
// Serves the built client from Express, so the app, the API and the socket share one
// origin in production (docs/phase-2-implementation-plan.md §11, topology A): the
// session cookie is first-party, and there is no CORS to configure.
import { existsSync } from 'fs';
import { join } from 'path';
import express, { type Express } from 'express';

/**
 * Mounts the client build in `dir` (client/dist) on `app`, after the API routes.
 * Returns false and mounts nothing when `dir` has no index.html, as in development,
 * where Vite serves the client and proxies /api and /socket.io here.
 */
export function serveClient(app: Express, dir: string): boolean {
  const indexHtml = join(dir, 'index.html');
  if (!existsSync(indexHtml)) return false;

  // Vite's hashed build files: new content gets a new name, so a year's cache is safe.
  app.use('/assets', express.static(join(dir, 'assets'), { immutable: true, maxAge: '1y', index: false }));
  // A missing asset is a 404, never index.html, which the browser would try to run as a script.
  app.use('/assets', (_req, res) => {
    res.status(404).end();
  });
  // Other top-level files of the build (favicon.svg), revalidated on every use.
  app.use(express.static(dir, { index: false }));
  // Every other page is a client route (/, /chat, /login …): index.html, never cached, so
  // a deploy shows up at once. /api keeps its JSON 404; /socket.io belongs to Socket.io.
  app.get(/^(?!\/(?:api|socket\.io)(?:\/|$))/, (_req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile(indexHtml);
  });
  return true;
}
