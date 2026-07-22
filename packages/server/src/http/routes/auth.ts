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
import { setCookie, getCookie, deleteCookie } from 'hono/cookie';
import type { AppContext, AppEnv } from '../app.js';
import { ApiError } from '../../errors.js';
import { requireEmail } from '../../auth/email-address.js';
import { MAGIC_LINK_MINUTES } from '../../auth/service.js';
import { buildAuthorisationUrl, signState, verifyState } from '../../auth/google.js';
import { magicLinkEmail } from '../../mail/templates.js';
import { setSessionCookie, clearSessionCookie, readSessionCookie } from '../cookies.js';
import { escapeHtml } from '../../render/escape.js';
import type { GoogleConfig } from '../../config.js';

const GOOGLE_STATE_COOKIE = 'oa_google_state';

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

  // -------------------------------------------------------------------------
  // Google
  // -------------------------------------------------------------------------

  const googleRedirectUri = `${config.baseUrl}/auth/google/callback`;

  /** "Continue with Google" sends the browser here. */
  app.get('/auth/google/start', (c) => {
    const google = requireGoogleConfigured(context);
    const state = signState(config.sessionSecret, safeRedirect(c.req.query('redirectTo')));

    // The state also goes in a cookie, so the callback can prove it belongs to a
    // sign-in this browser started rather than one somebody else set up.
    setCookie(c, GOOGLE_STATE_COOKIE, state, {
      httpOnly: true,
      secure: config.baseUrl.startsWith('https://'),
      sameSite: 'Lax',
      path: '/auth/google',
      maxAge: 600,
    });

    return c.redirect(
      buildAuthorisationUrl({ config: google, redirectUri: googleRedirectUri, state }),
      302,
    );
  });

  /** Google sends the browser back here. */
  app.get('/auth/google/callback', async (c) => {
    requireGoogleConfigured(context);

    const error = c.req.query('error');
    if (error) {
      // Someone pressed cancel on Google's screen. Not an error worth a stack trace.
      return c.redirect('/?signin=cancelled', 302);
    }

    const state = c.req.query('state');
    const cookieState = getCookie(c, GOOGLE_STATE_COOKIE);
    deleteCookie(c, GOOGLE_STATE_COOKIE, { path: '/auth/google' });

    if (!state || !cookieState || state !== cookieState) {
      throw new ApiError(
        'unauthenticated',
        'This sign-in could not be completed. Start again from the sign-in page.',
      );
    }

    const { redirectTo } = verifyState(config.sessionSecret, state);

    const code = c.req.query('code');
    if (!code) throw new ApiError('validation_failed', 'Google sent no authorisation code.');

    const identity = await context.google.exchangeCode(code, googleRedirectUri);

    // An unverified Google address proves nothing. Accepting one would let
    // somebody claim an address they do not own, and with it any artifact
    // already shared with that address.
    if (!identity.emailVerified) {
      throw new ApiError(
        'unauthenticated',
        'Google has not verified that email address, so it cannot be used to sign in here.',
      );
    }

    const { user } = auth.findOrCreateUser(identity.email, {
      verified: true,
      displayName: identity.displayName,
    });
    const session = auth.createSession(user.id, describeClient(c.req.header('user-agent')));
    setSessionCookie(c, config, session.token, session.expiresAt);

    return c.redirect(redirectTo ?? '/', 302);
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
 * Google sign-in is optional. When an instance has no credentials set, the login
 * page shows email links only and these routes say so plainly rather than failing
 * in a way that looks like a bug.
 */
function requireGoogleConfigured(context: AppContext): GoogleConfig {
  if (context.config.google === null) {
    throw new ApiError(
      'not_found',
      'This instance does not offer Google sign-in. Use a sign-in link instead.',
    );
  }
  return context.config.google;
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
