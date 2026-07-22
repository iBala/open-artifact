/**
 * Endpoints for signing in from the command line. See auth/device-flow.ts for how
 * the flow works and why it is shaped this way.
 */

import type { Hono } from 'hono';
import type { AppContext, AppEnv } from '../app.js';
import { ApiError } from '../../errors.js';
import { requireUser, currentUser } from '../session.js';
import { escapeHtml } from '../../render/escape.js';

export function registerDeviceRoutes(app: Hono<AppEnv>, context: AppContext): void {
  const { devices, config } = context;

  /** The CLI starts here. */
  app.post('/api/auth/device', async (c) => {
    const body = await readOptionalJson(c.req.raw);
    const label = typeof body.label === 'string' ? body.label.slice(0, 80) : null;

    const started = devices.start(label);
    return c.json({
      deviceCode: started.deviceCode,
      userCode: started.userCode,
      verificationUrl: started.verificationUrl,
      expiresInSeconds: started.expiresInSeconds,
      intervalSeconds: started.intervalSeconds,
    });
  });

  /** The CLI polls here until somebody approves. */
  app.post('/api/auth/device/token', async (c) => {
    const body = await readOptionalJson(c.req.raw);
    if (typeof body.deviceCode !== 'string') {
      throw new ApiError('validation_failed', 'deviceCode is required.');
    }

    const result = devices.poll(body.deviceCode);
    switch (result.state) {
      case 'pending':
        // Not an error: the CLI is meant to keep waiting. A distinct status so it
        // never has to read the message to know what happened.
        return c.json({ state: 'pending' }, 202);
      case 'denied':
        return c.json({ state: 'denied' }, 403);
      case 'expired':
        return c.json({ state: 'expired' }, 410);
      case 'approved':
        return c.json({
          state: 'approved',
          token: result.token.token,
          expiresAt: result.token.expiresAt,
        });
    }
  });

  /** The page the person opens to approve. */
  app.get('/auth/device', (c) => {
    const code = c.req.query('code') ?? '';
    const user = c.get('user');

    if (!user) {
      // Sign in first, then come straight back here with the code intact.
      const back = `/auth/device${code ? `?code=${encodeURIComponent(code)}` : ''}`;
      return c.redirect(`/login?redirectTo=${encodeURIComponent(back)}`, 302);
    }

    const pending = code ? devices.findByUserCode(code) : undefined;
    return c.html(
      approvalPage({
        code,
        email: user.email,
        instance: config.baseUrl,
        state:
          !pending ? 'unknown'
          : pending.expiresAt <= new Date().toISOString() ? 'expired'
          : pending.approvedAt !== null ? 'already-approved'
          : pending.deniedAt !== null ? 'already-denied'
          : 'pending',
        label: pending?.label ?? null,
      }),
    );
  });

  /** Approving or refusing, from that page. */
  app.post('/api/auth/device/approve', requireUser, async (c) => {
    const body = await readOptionalJson(c.req.raw);
    if (typeof body.userCode !== 'string') {
      throw new ApiError('validation_failed', 'userCode is required.');
    }

    if (body.approve === false) {
      devices.deny(body.userCode);
      return c.json({ approved: false });
    }

    devices.approve(body.userCode, currentUser(c).id);
    return c.json({ approved: true });
  });
}

async function readOptionalJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await request.json();
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

type ApprovalState = 'pending' | 'unknown' | 'expired' | 'already-approved' | 'already-denied';

/**
 * Server-rendered rather than part of the web app, because this page has to work
 * before the app has loaded and because it is the one screen where clarity
 * matters more than polish: somebody is about to hand a program their account.
 */
function approvalPage(input: {
  code: string;
  email: string;
  instance: string;
  state: ApprovalState;
  label: string | null;
}): string {
  const body =
    input.state === 'pending'
      ? pendingBody(input)
      : `<h1>${escapeHtml(headlineFor(input.state))}</h1>
         <p class="muted">${escapeHtml(explanationFor(input.state))}</p>`;

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Approve sign-in</title>
<style>${STYLES}</style>
</head><body>
<main class="card">${body}</main>
<script>${APPROVAL_SCRIPT}</script>
</body></html>`;
}

function pendingBody(input: { code: string; email: string; label: string | null }): string {
  return `
  <h1>Approve this sign-in?</h1>
  <p class="muted">
    ${input.label ? `<strong>${escapeHtml(input.label)}</strong> is` : 'A program is'}
    asking to use Open Artifact as <strong>${escapeHtml(input.email)}</strong>.
    It will be able to publish, change and delete your artifacts.
  </p>

  <p class="muted">Only approve this if the code below matches the one in your terminal.</p>
  <p class="code" data-code="${escapeHtml(input.code)}">${escapeHtml(input.code)}</p>

  <div class="actions">
    <button type="button" data-action="approve" class="primary">Yes, approve</button>
    <button type="button" data-action="deny" class="secondary">No, this was not me</button>
  </div>
  <p class="result" hidden></p>`;
}

function headlineFor(state: ApprovalState): string {
  switch (state) {
    case 'unknown':
      return 'That code does not match anything';
    case 'expired':
      return 'That code has expired';
    case 'already-approved':
      return 'Already approved';
    case 'already-denied':
      return 'Already refused';
    default:
      return '';
  }
}

function explanationFor(state: ApprovalState): string {
  switch (state) {
    case 'unknown':
      return 'Check the code your terminal is showing, and try the link again.';
    case 'expired':
      return 'Codes last ten minutes. Run open-artifact login again to get a new one.';
    case 'already-approved':
      return 'Your terminal should be signed in. You can close this page.';
    case 'already-denied':
      return 'Nothing was granted. You can close this page.';
    default:
      return '';
  }
}

const APPROVAL_SCRIPT = `
document.querySelectorAll('[data-action]').forEach(function (button) {
  button.addEventListener('click', function () {
    var approve = button.dataset.action === 'approve';
    var code = document.querySelector('.code').dataset.code;
    var result = document.querySelector('.result');

    document.querySelectorAll('[data-action]').forEach(function (b) { b.disabled = true; });

    fetch('/api/auth/device/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userCode: code, approve: approve })
    }).then(function (response) {
      result.hidden = false;
      if (response.ok) {
        document.querySelector('.actions').hidden = true;
        result.textContent = approve
          ? 'Approved. Your terminal is signing in now, and you can close this page.'
          : 'Refused. Nothing was granted.';
      } else {
        result.textContent = 'That did not work. Refresh and try again.';
        document.querySelectorAll('[data-action]').forEach(function (b) { b.disabled = false; });
      }
    });
  });
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
  .code { margin: 20px 0 24px; font: 600 28px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
          letter-spacing: 0.12em; text-align: center; padding: 18px; border: 1px solid var(--edge); border-radius: 10px; }
  .actions { display: flex; flex-direction: column; gap: 10px; }
  button { font: inherit; padding: 11px 16px; border-radius: 9px; cursor: pointer; border: 1px solid var(--edge); }
  button:disabled { opacity: 0.5; cursor: default; }
  .primary { background: canvastext; color: canvas; border-color: transparent; font-weight: 500; }
  .secondary { background: transparent; }
  .result { margin: 16px 0 0; font-size: 15px; }
`;
