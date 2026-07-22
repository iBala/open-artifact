/**
 * Sign-in endpoints.
 *
 * A note on what these deliberately do not reveal: asking for a sign-in link
 * always answers the same way, whether or not the address has an account and
 * whether or not it is allowed to create one. Otherwise this endpoint becomes a
 * way to ask "does this person use this instance?", which for a private team
 * instance is worth keeping quiet.
 */

import type { Hono } from 'hono';
import type { AppContext, AppEnv } from '../app.js';
import { ApiError } from '../../errors.js';
import { requireEmail } from '../../auth/email-address.js';
import { MAGIC_LINK_MINUTES } from '../../auth/service.js';
import { magicLinkEmail } from '../../mail/templates.js';
import { setSessionCookie, clearSessionCookie, readSessionCookie } from '../cookies.js';
import { escapeHtml } from '../../render/escape.js';

export function registerAuthRoutes(app: Hono<AppEnv>, context: AppContext): void {
  const { auth, config, mailer } = context;

  /** How to sign in here. The login page asks this before drawing its buttons. */
  app.get('/api/auth/methods', (c) =>
    c.json({
      magicLink: true,
      google: config.google !== null,
      signupMode: config.signupMode,
    }),
  );

  /** Ask for a sign-in link. */
  app.post('/api/auth/magic-link', async (c) => {
    const body = await readJson(c.req.raw);
    const email = requireEmail(body.email);
    const redirectTo = safeRedirect(body.redirectTo);

    const { token } = auth.requestMagicLink(email, redirectTo);
    const link = `${config.baseUrl}/auth/verify?token=${encodeURIComponent(token)}`;

    const content = magicLinkEmail({
      link,
      isNewAccount: auth.findUserByEmail(email) === undefined,
      instanceName: instanceNameFrom(config.baseUrl),
      expiryMinutes: MAGIC_LINK_MINUTES,
    });

    await mailer.send({ to: email, subject: content.subject, text: content.text, html: content.html });

    // The same answer for every address, always. See the note at the top.
    return c.json({
      sent: true,
      message: 'If that address can sign in here, a link is on its way.',
    });
  });

  /** Follow a sign-in link. This is the URL in the email. */
  app.get('/auth/verify', (c) => {
    const token = c.req.query('token');
    if (!token) {
      throw new ApiError('validation_failed', 'This link is missing its token.');
    }

    const result = auth.verifyMagicLink(token, describeClient(c.req.header('user-agent')));
    setSessionCookie(c, config, result.session.token, result.session.expiresAt);

    return c.redirect(result.redirectTo ?? '/', 302);
  });

  /** Who am I? Used by the web app on load and by `open-artifact whoami`. */
  app.get('/api/auth/me', (c) => {
    const user = c.get('user');
    if (!user) throw new ApiError('unauthenticated', 'You are not signed in.');
    return c.json({
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      createdAt: user.createdAt,
    });
  });

  /** Sign out of this browser. */
  app.post('/api/auth/sign-out', (c) => {
    const token = readSessionCookie(c);
    if (token) auth.revokeSession(token);
    clearSessionCookie(c, config);
    return c.json({ signedOut: true });
  });
}

/**
 * Only ever redirect to a path on this instance. An open redirect here would let
 * someone send a link that signs a person in and then drops them on a page they
 * control, wearing our domain in the address bar on the way.
 */
function safeRedirect(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (!value.startsWith('/') || value.startsWith('//')) return null;
  return value;
}

/** A label for the sessions page, so a person can tell their devices apart. */
function describeClient(userAgent: string | undefined): string {
  if (!userAgent) return 'Unknown device';

  const browser =
    /Firefox\//.test(userAgent) ? 'Firefox'
    : /Edg\//.test(userAgent) ? 'Edge'
    : /Chrome\//.test(userAgent) ? 'Chrome'
    : /Safari\//.test(userAgent) ? 'Safari'
    : 'Browser';

  const platform =
    /iPhone|iPad/.test(userAgent) ? 'iOS'
    : /Android/.test(userAgent) ? 'Android'
    : /Mac OS X/.test(userAgent) ? 'macOS'
    : /Windows/.test(userAgent) ? 'Windows'
    : /Linux/.test(userAgent) ? 'Linux'
    : 'device';

  return `${browser} on ${platform}`;
}

/** "artifacts.example.com" reads better in an email than a full URL. */
export function instanceNameFrom(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return 'Open Artifact';
  }
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await request.json();
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new ApiError('validation_failed', 'The request body must be a JSON object.');
  }
}

/** Used by the sign-in pages that the server renders before the web app exists. */
export function signInFallbackPage(message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Sign in</title></head>
<body><p>${escapeHtml(message)}</p></body></html>`;
}
