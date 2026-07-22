/**
 * Serving the web app.
 *
 * The built app is copied into this package and served from the same origin as
 * the API. That is what makes the whole product one container with nothing to
 * configure: no separate static host, no CORS, and a session cookie that just
 * works because there is only one origin.
 *
 * Everything the server owns is registered before this, so the catch-all only
 * ever sees addresses that belong to the app.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Hono } from 'hono';
import type { AppContext, AppEnv } from '../app.js';

const PUBLIC_DIR = resolve(fileURLToPath(new URL('../../../public', import.meta.url)));

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.map': 'application/json',
};

export function registerWebAppRoutes(app: Hono<AppEnv>, context: AppContext): void {
  const indexPath = join(PUBLIC_DIR, 'index.html');

  if (!existsSync(indexPath)) {
    // Running the server without building the app is normal in development,
    // where Vite serves the app on its own port and proxies here.
    context.logger.info('web app not built, serving the API only', { expectedAt: PUBLIC_DIR });
    return;
  }

  app.get('*', async (c, next) => {
    const requestPath = new URL(c.req.url).pathname;

    // Anything under /api belongs to the API. An unknown endpoint there is a
    // 404 with a JSON body, not a page: a client calling a misspelled endpoint
    // should be told so, not handed HTML to parse.
    if (requestPath.startsWith('/api/')) return next();

    const asset = readAsset(requestPath);
    if (asset) {
      // Built asset names contain a content hash, so a given URL never changes
      // what it returns and can be cached hard.
      const immutable = requestPath.startsWith('/assets/');
      c.header('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
      c.header('X-Content-Type-Options', 'nosniff');
      return c.body(new Uint8Array(asset.body), 200, { 'Content-Type': asset.contentType });
    }

    // Any other address is a screen inside the app, which does its own routing.
    c.header('Cache-Control', 'no-cache');
    c.header('X-Content-Type-Options', 'nosniff');
    return c.html(readFileSync(indexPath, 'utf8'));
  });
}

function readAsset(requestPath: string): { body: Buffer; contentType: string } | null {
  const extension = extname(requestPath);
  if (extension === '' || extension === '.html') return null;

  // Resolve, then check the result is still inside the public directory. Without
  // this, a path with ../ in it reads any file the process can reach.
  const candidate = resolve(join(PUBLIC_DIR, normalize(requestPath)));
  if (!candidate.startsWith(`${PUBLIC_DIR}/`)) return null;
  if (!existsSync(candidate)) return null;

  return {
    body: readFileSync(candidate),
    contentType: CONTENT_TYPES[extension] ?? 'application/octet-stream',
  };
}
