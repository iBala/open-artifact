/**
 * Serving artifacts to a browser.
 *
 * The threat this file exists to close: an artifact is written by an AI and read
 * by a person who is signed in. If script inside an artifact could reach the
 * reader's session, publishing an artifact would mean handing over an account.
 *
 * How the two formats are handled, and why they differ:
 *
 * - Markdown is rendered into the page itself. It is safe there because the
 *   rendering pipeline drops every script, event handler and dangerous URL before
 *   the HTML exists (see render/markdown.ts). Being in the page rather than a
 *   frame is what lets a reader select a paragraph and comment on it (Sprint 6).
 *
 * - HTML is the publisher's own document, scripts and all, so it never touches
 *   the page. It loads in an iframe with `sandbox="allow-scripts"`, which gives it
 *   an opaque origin: no access to cookies, no same-origin API calls.
 *
 * The content endpoint also sends `Content-Security-Policy: sandbox allow-scripts`
 * itself. That matters because someone can paste the content URL straight into a
 * tab, where there is no iframe to sandbox it. The header makes that tab opaque
 * too. Removing it reopens the hole.
 */

import type { Hono } from 'hono';
import type { AppContext, AppEnv } from '../app.js';
import { renderMarkdown } from '../../render/markdown.js';
import { escapeHtml } from '../../render/escape.js';
import type { ArtifactDetail } from '../../artifacts/service.js';

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

/** The shell page around the content. It loads no script and no third-party asset. */
const SHELL_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  'img-src data:',
  "frame-src 'self'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

export function registerViewRoutes(app: Hono<AppEnv>, context: AppContext): void {
  const { artifacts } = context;

  /** The page a reader opens. */
  app.get('/a/:slug', (c) => {
    const artifact = artifacts.getBySlug(c.req.param('slug'));
    c.header('Content-Security-Policy', SHELL_CONTENT_SECURITY_POLICY);
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    // An artifact is per-reader: never let a shared cache hold on to one.
    c.header('Cache-Control', 'private, no-store');
    return c.html(renderShell(artifact));
  });

  /**
   * The artifact's own bytes, for the iframe to load. Only HTML artifacts use
   * this; Markdown is already in the shell.
   */
  app.get('/a/:slug/content', (c) => {
    const artifact = artifacts.getBySlug(c.req.param('slug'));

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

function renderShell(artifact: ArtifactDetail): string {
  const body =
    artifact.type === 'markdown'
      ? `<article class="prose">${renderMarkdown(artifact.content)}</article>`
      : `<iframe
           class="frame"
           src="/a/${encodeURIComponent(artifact.slug)}/content"
           sandbox="allow-scripts"
           referrerpolicy="no-referrer"
           title="${escapeHtml(artifact.title)}"></iframe>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(artifact.title)}</title>
<style>${SHELL_STYLES}</style>
</head>
<body>
<header class="bar">
  <h1 class="bar-title">${escapeHtml(artifact.title)}</h1>
  <p class="bar-meta">Updated <time datetime="${escapeHtml(artifact.updatedAt)}">${escapeHtml(artifact.updatedAt)}</time></p>
</header>
<main>${body}</main>
</body>
</html>`;
}

/**
 * Deliberately plain. The designed viewer arrives in Sprint 5; this exists so the
 * Sprint 1 demo is readable rather than raw.
 */
const SHELL_STYLES = `
  :root { color-scheme: light dark; --edge: color-mix(in srgb, currentColor 12%, transparent); }
  * { box-sizing: border-box; }
  body { margin: 0; font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  .bar { padding: 20px 24px; border-bottom: 1px solid var(--edge); }
  .bar-title { margin: 0; font-size: 17px; font-weight: 600; letter-spacing: -0.01em; }
  .bar-meta { margin: 4px 0 0; font-size: 13px; opacity: 0.6; }
  main { max-width: 820px; margin: 0 auto; padding: 32px 24px 96px; }
  .frame { display: block; width: 100%; height: calc(100vh - 150px); border: 1px solid var(--edge); border-radius: 10px; background: #fff; }
  .prose > :first-child { margin-top: 0; }
  .prose h1, .prose h2, .prose h3 { line-height: 1.25; letter-spacing: -0.015em; margin: 1.8em 0 0.6em; }
  .prose pre { padding: 14px 16px; border-radius: 8px; overflow-x: auto; border: 1px solid var(--edge); }
  .prose code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9em; }
  .prose pre code { font-size: 0.85em; }
  .prose table { border-collapse: collapse; width: 100%; display: block; overflow-x: auto; }
  .prose th, .prose td { border: 1px solid var(--edge); padding: 8px 12px; text-align: left; }
  .prose img { max-width: 100%; height: auto; }
  .prose blockquote { margin: 1.2em 0; padding-left: 16px; border-left: 3px solid var(--edge); opacity: 0.85; }
`;
