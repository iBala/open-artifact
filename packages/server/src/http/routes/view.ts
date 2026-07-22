/**
 * Serving an artifact's own bytes.
 *
 * The threat this file exists to close: an artifact is written by an AI and read
 * by a person who is signed in. If script inside an artifact could reach the
 * reader's session, publishing an artifact would mean handing over an account.
 *
 * The page a reader opens is a screen in the web app. This endpoint serves only
 * the artifact's content, which the app then treats differently by format:
 *
 * - Markdown is rendered and sanitised here. Every script, event handler and
 *   dangerous URL is gone before the HTML exists (see render/markdown.ts), which
 *   is what makes it safe for the app to place in the page. Being in the page
 *   rather than a frame is what lets a reader select a paragraph and comment on
 *   it (Sprint 6).
 *
 * - HTML is the publisher's own document, scripts and all, so it never touches
 *   the app's page. The app loads it in an iframe with `sandbox="allow-scripts"`,
 *   which gives it an opaque origin: no access to cookies, no same-origin API
 *   calls.
 *
 * This endpoint also sends `Content-Security-Policy: sandbox allow-scripts`
 * itself. That matters because somebody can paste the content URL straight into a
 * tab, where there is no iframe to sandbox it. The header makes that tab opaque
 * too. Removing it reopens the hole.
 */

import type { Hono } from 'hono';
import type { AppContext, AppEnv } from '../app.js';
import { renderMarkdown } from '../../render/markdown.js';
import { requireAccess } from '../../artifacts/access.js';

/**
 * What artifact content is allowed to do.
 *
 * `connect-src 'none'` blocks fetch and XHR, so script in an artifact cannot call
 * this server's API or send anything anywhere. Images, fonts and media are limited
 * to data: and blob: URLs; an artifact cannot load a remote image, because a
 * remote image request is both a tracking beacon and a way to smuggle data out in
 * a URL. The practical rule for publishers: an artifact must be self-contained.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' blob:",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  'sandbox allow-scripts',
].join('; ');

export function registerViewRoutes(app: Hono<AppEnv>, context: AppContext): void {
  const { artifacts, sharing } = context;

  /**
   * The artifact's own bytes. HTML artifacts are loaded from here into a
   * sandboxed frame; Markdown is fetched from here already rendered.
   */
  app.get('/a/:slug/content', (c) => {
    const artifact = artifacts.getBySlug(c.req.param('slug'));
    requireAccess(c.get('user') ?? null, sharing.accessFactsFor(artifact), 'view');

    c.header('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Cache-Control', 'private, no-store');
    // Belt and braces with the CSP sandbox directive above, for older browsers.
    c.header('X-Frame-Options', 'SAMEORIGIN');

    if (artifact.type === 'markdown') {
      return c.body(renderMarkdown(artifact.content), 200, {
        'Content-Type': 'text/html; charset=utf-8',
      });
    }
    return c.body(artifact.content, 200, { 'Content-Type': 'text/html; charset=utf-8' });
  });
}
