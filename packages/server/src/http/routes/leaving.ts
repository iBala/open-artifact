/**
 * The interstitial shown when a reader clicks an off-site link inside a PUBLIC
 * artifact.
 *
 * Why this exists: a public artifact is written by a stranger and served from
 * this instance's own domain. A raw off-site link would carry the reader away
 * without warning, from a domain they trust to one they have never seen. Public
 * Markdown artifacts have their off-site links rewritten to /leaving?to=<url>
 * (see render/markdown.ts and routes/view.ts), so the reader lands here first and
 * chooses whether to continue.
 *
 * Server-rendered rather than part of the web app, for the same reason as the
 * device page: it has to work as a plain page reached straight from a link,
 * before any app has loaded, and clarity matters more than polish here.
 *
 * This route must never become an open redirect. It only ever renders a clickable
 * link for an absolute http/https URL. Anything else — missing, javascript:,
 * data:, a relative path, or not a URL at all — gets a short "not valid" page
 * with no outbound link at all. And even for a valid URL it never redirects on
 * its own: the reader has to click.
 *
 * Known gap this does NOT cover: HTML artifacts. Their off-site links are not
 * rewritten (see routes/view.ts for why), so this interstitial only protects
 * links inside Markdown artifacts.
 */

import type { Hono } from 'hono';
import type { AppContext, AppEnv } from '../app.js';
import { escapeHtml } from '../../render/escape.js';

export function registerLeavingRoutes(app: Hono<AppEnv>, context: AppContext): void {
  const { config } = context;

  app.get('/leaving', (c) => {
    const destination = safeDestination(c.req.query('to'));
    return c.html(
      leavingPage({
        // The host, not the whole URL: it is the part a reader recognises as
        // "the site I trusted".
        instanceHost: hostOf(config.baseUrl),
        destination,
      }),
    );
  });
}

/**
 * The destination, only if it is a plain absolute http/https URL. Returns null
 * for everything else, which is what stops this page redirecting to javascript:,
 * data:, a relative path, or nonsense.
 */
function safeDestination(raw: string | undefined): URL | null {
  if (!raw) return null;
  let url: URL;
  try {
    // No base: a relative "to" has no absolute meaning here and must be refused,
    // so parsing without a base makes it throw.
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url;
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

function leavingPage(input: { instanceHost: string; destination: URL | null }): string {
  const body = input.destination
    ? leavingBody(input.instanceHost, input.destination)
    : invalidBody();

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer">
<title>Leaving ${escapeHtml(input.instanceHost)}</title>
<style>${STYLES}</style>
</head><body>
<main class="card">${body}</main>
<script>${BACK_SCRIPT}</script>
</body></html>`;
}

function leavingBody(instanceHost: string, destination: URL): string {
  return `
  <h1>You are leaving ${escapeHtml(instanceHost)}</h1>
  <p class="muted">
    This link was written by whoever published the artifact, and it goes to another
    site. Check the address before you continue.
  </p>
  <p class="url">${escapeHtml(destination.href)}</p>

  <div class="actions">
    <a class="primary" href="${escapeHtml(destination.href)}" rel="noopener noreferrer nofollow">Continue to this site</a>
    <button type="button" class="secondary" data-action="back">Go back</button>
  </div>`;
}

function invalidBody(): string {
  return `
  <h1>That link was not valid</h1>
  <p class="muted">
    The address was missing or was not an ordinary web link, so there is nothing to
    continue to. Go back to the page you came from.
  </p>
  <div class="actions">
    <button type="button" class="secondary" data-action="back">Go back</button>
  </div>`;
}

const BACK_SCRIPT = `
document.querySelectorAll('[data-action="back"]').forEach(function (button) {
  button.addEventListener('click', function () { history.back(); });
});
`;

const STYLES = `
  :root { color-scheme: light dark; --edge: color-mix(in srgb, currentColor 14%, transparent); }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
         font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  .card { max-width: 440px; width: 100%; border: 1px solid var(--edge); border-radius: 14px; padding: 28px; }
  h1 { margin: 0 0 12px; font-size: 21px; letter-spacing: -0.02em; }
  .muted { margin: 0 0 16px; opacity: 0.75; font-size: 15px; }
  .url { margin: 20px 0 24px; font: 500 15px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
         word-break: break-all; padding: 14px 16px; border: 1px solid var(--edge); border-radius: 10px; }
  .actions { display: flex; flex-direction: column; gap: 10px; }
  .primary, .secondary { font: inherit; padding: 11px 16px; border-radius: 9px; cursor: pointer;
         border: 1px solid var(--edge); text-align: center; text-decoration: none; }
  .primary { background: canvastext; color: canvas; border-color: transparent; font-weight: 500; }
  .secondary { background: transparent; color: inherit; }
`;
