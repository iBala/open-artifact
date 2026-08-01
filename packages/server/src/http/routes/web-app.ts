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
 *
 * ## Why this document has a Content-Security-Policy
 *
 * An artifact is a stranger's page, and the app shows it in an iframe. The frame
 * is sandboxed without `allow-same-origin`, so script inside it runs at an opaque
 * origin and cannot touch the reader's session. That is the whole security model
 * of the product, and it holds.
 *
 * What it does not do on its own is stop the artifact navigating **its own
 * frame** somewhere else. A sandboxed frame may replace itself, and the page it
 * lands on inherits the sandbox flags, the opaque origin, and — from the app's
 * point of view — the very same `contentWindow` object. So a page the publisher
 * controls, and can change after publishing, becomes indistinguishable from the
 * artifact when the app checks `event.source` on a message.
 *
 * `frame-src 'self'` closes that. It applies to every navigation of a nested
 * frame, not only the first, so the frame can hold nothing but this instance's
 * own content. Without it the identity check the comment bridge relies on leans
 * on nothing at all, which is why this lands before the bridge does.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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

/**
 * The app document's policy.
 *
 * `frame-src 'self'` is the load-bearing one; see the note at the top of this
 * file. The rest is ordinary hardening of an origin that holds a session:
 * nothing may be loaded from another host, no plugins, no rewriting the base
 * URL, and no form posting anywhere but back here.
 *
 * `style-src` allows inline because React writes style attributes, and
 * `connect-src 'self'` is all the app needs — it talks only to its own API.
 */
function policyFor(scriptHashes: string[]): string {
  return [
    "default-src 'self'",
    // Hashes rather than 'unsafe-inline': the shell runs one small blocking
    // script to settle the theme before anything is drawn, and it is hashed from
    // the file we actually serve, so editing it can never silently break it.
    `script-src 'self' ${scriptHashes.join(' ')}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    // The one that matters. An artifact may not navigate its own frame off this
    // instance and keep the frame identity the app trusts.
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}

/**
 * SHA-256 hashes of every inline script in the shell, in CSP form.
 *
 * Read from the built file at startup rather than written down here. A hash
 * copied into source drifts the moment somebody edits the script, and the
 * failure is silent to whoever made the edit and loud only to the reader whose
 * theme stops working.
 */
export function inlineScriptHashes(html: string): string[] {
  const hashes: string[] = [];
  const pattern = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi;

  for (const match of html.matchAll(pattern)) {
    const body = match[1] ?? '';
    if (body.trim().length === 0) continue;
    hashes.push(`'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`);
  }

  return hashes;
}

export function registerWebAppRoutes(app: Hono<AppEnv>, context: AppContext): void {
  const indexPath = join(PUBLIC_DIR, 'index.html');

  if (!existsSync(indexPath)) {
    // Running the server without building the app is normal in development,
    // where Vite serves the app on its own port and proxies here.
    context.logger.info('web app not built, serving the API only', { expectedAt: PUBLIC_DIR });
    return;
  }

  const shell = readFileSync(indexPath, 'utf8');
  const policy = policyFor(inlineScriptHashes(shell));

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
    c.header('Content-Security-Policy', policy);
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
