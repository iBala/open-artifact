/**
 * Serving the privacy policy at /privacy, and its source at /privacy.md.
 *
 * Public and unauthenticated, like /setup.md: a privacy policy nobody can read
 * without an account is not a privacy policy. Server-rendered rather than a page
 * in the web app, for the reason the leaving interstitial is — it has to be a
 * plain page that works when reached straight from a link, including by a
 * reviewer or a crawler that runs no JavaScript.
 *
 * One source, two representations. The Markdown in setup/privacy-doc.ts is the
 * document; /privacy is that Markdown rendered, /privacy.md is that Markdown.
 * They cannot drift because there is only one of them.
 */

import type { Context, Hono } from 'hono';
import type { AppContext, AppEnv } from '../app.js';
import { privacyDoc } from '../../setup/privacy-doc.js';
import { renderMarkdown } from '../../render/markdown.js';
import { escapeHtml } from '../../render/escape.js';

export function registerLegalRoutes(app: Hono<AppEnv>, context: AppContext): void {
  const { config } = context;

  // Built once at startup. The document only depends on configuration, and
  // configuration does not change while the process is running.
  const markdown = privacyDoc({
    baseUrl: config.baseUrl,
    contactEmail: config.privacyContactEmail,
    sendsEmail: config.smtp !== null,
  });

  // No wrapExternalLinks: that interstitial exists because a public artifact is
  // written by a stranger. This document is written by the operator, so its links
  // are the operator's own and need no warning.
  const page = privacyPage(hostOf(config.baseUrl), renderMarkdown(markdown));

  app.get('/privacy', (c: Context<AppEnv>) => {
    c.header('Cache-Control', 'public, max-age=300');
    return c.html(page);
  });

  app.get('/privacy.md', (c: Context<AppEnv>) => {
    c.header('Content-Type', 'text/markdown; charset=utf-8');
    c.header('Cache-Control', 'public, max-age=300');
    c.header('X-Content-Type-Options', 'nosniff');
    return c.body(markdown);
  });
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

function privacyPage(instanceHost: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>Privacy policy — ${escapeHtml(instanceHost)}</title>
<style>${STYLES}</style>
</head><body>
<main class="doc">${body}</main>
</body></html>`;
}

const STYLES = `
  :root { color-scheme: light dark; --edge: color-mix(in srgb, currentColor 14%, transparent); }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 48px 24px 96px;
         font: 16px/1.7 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  .doc { max-width: 680px; margin: 0 auto; }
  h1 { font-size: 30px; letter-spacing: -0.02em; margin: 0 0 8px; }
  h2 { font-size: 19px; letter-spacing: -0.01em; margin: 40px 0 12px;
       padding-top: 20px; border-top: 1px solid var(--edge); }
  p { margin: 0 0 14px; }
  strong { font-weight: 600; }
  a { color: inherit; text-underline-offset: 2px; }
  code { font: 0.9em ui-monospace, SFMono-Regular, Menlo, monospace;
         border: 1px solid var(--edge); border-radius: 5px; padding: 1px 5px; }
  h1 + p { opacity: 0.75; }
`;
