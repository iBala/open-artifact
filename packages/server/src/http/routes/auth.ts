/**
 * Sign-in endpoints.
 *
 * A note on what these deliberately do not reveal: asking for a sign-in code
 * always answers the same way, whether or not the address has an account and
 * whether or not it is allowed to create one. Otherwise this endpoint becomes a
 * way to ask "does this person use this instance?", which for a private team
 * instance is worth keeping quiet.
 *
 * Why a code rather than a link in the email: mail clients open links in their
 * own in-app browser, which has none of the person's tabs and none of their
 * session. A code is typed back into the tab they started in, so they end up
 * where they asked to be. That is also why verifying answers with JSON instead of
 * a redirect: the web app calls it with fetch and stays on the page.
 */

import type { Hono } from 'hono';
import { setCookie, getCookie, deleteCookie } from 'hono/cookie';
import type { AppContext, AppEnv } from '../app.js';
import { ApiError } from '../../errors.js';
import { requireEmail } from '../../auth/email-address.js';
import { SIGN_IN_CODE_MINUTES } from '../../auth/service.js';
import { buildAuthorisationUrl, signState, verifyState } from '../../auth/google.js';
import { signInCodeEmail } from '../../mail/templates.js';
import { setSessionCookie, clearSessionCookie, readSessionCookie } from '../cookies.js';
import { requireUser, currentUser } from '../session.js';

import { escapeHtml } from '../../render/escape.js';
import type { GoogleConfig } from '../../config.js';

const GOOGLE_STATE_COOKIE = 'oa_google_state';

export function registerAuthRoutes(app: Hono<AppEnv>, context: AppContext): void {
  const { auth, config, mailer , rateLimiter } = context;

  /**
   * Asking for a code sends an email to an address the caller picked, so an
   * unlimited endpoint here is a mail relay for anybody who finds it. Counted
   * per address, and tighter than anything else in the product.
   */
  const authLimit = rateLimiter.middleware({
    by: 'ip',
    bucket: 'auth',
    limit: config.limits.authRequestsPerHour,
    windowSeconds: 3600,
  });

  /** How to sign in here. The login page asks this before drawing its buttons. */
  app.get('/api/auth/methods', (c) =>
    c.json({
      emailCode: true,
      google: config.google !== null,
      signupMode: config.signupMode,
    }),
  );

  /** Ask for a sign-in code by email. */
  app.post('/api/auth/code', authLimit, async (c) => {
    const body = await readJson(c.req.raw);
    const email = requireEmail(body.email);
    const redirectTo = safeRedirect(body.redirectTo);

    const { code } = auth.requestSignInCode(email, redirectTo);

    const content = signInCodeEmail({
      code,
      isNewAccount: auth.findUserByEmail(email) === undefined,
      instanceName: instanceNameFrom(config.baseUrl),
      expiryMinutes: SIGN_IN_CODE_MINUTES,
    });

    await mailer.send({ to: email, subject: content.subject, text: content.text, html: content.html });

    // The same answer for every address, always. See the note at the top.
    return c.json({
      sent: true,
      message: 'If that address can sign in here, a code is on its way.',
    });
  });

  /**
   * Type the code in. Answers with JSON rather than redirecting, because the web
   * app calls this from the page the person is already on and moves them itself.
   */
  app.post('/api/auth/verify-code', authLimit, async (c) => {
    const body = await readJson(c.req.raw);
    const email = requireEmail(body.email);
    const code = typeof body.code === 'string' ? body.code : '';

    const result = auth.verifySignInCode(email, code, describeClient(c.req.header('user-agent')));
    setSessionCookie(c, config, result.session.token, result.session.expiresAt);

    return c.json({ redirectTo: result.redirectTo });
  });

  /**
   * The same code, exchanged for a command-line token instead of a browser
   * session. `open-artifact login` sends a code through /api/auth/code, then posts
   * it here. The token is what the CLI stores; it is not a cookie, so nothing is
   * set on the response.
   */
  app.post('/api/auth/cli-token', authLimit, async (c) => {
    const body = await readJson(c.req.raw);
    const email = requireEmail(body.email);
    const code = typeof body.code === 'string' ? body.code : '';
    const label = typeof body.label === 'string' ? body.label : null;

    const result = auth.exchangeCodeForToken(email, code, label);

    return c.json({
      token: result.token,
      email: result.email,
      expiresAt: result.expiresAt,
      isNewAccount: result.isNewAccount,
    });
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

    // Which assistants this person has connected, by the label each gave itself —
    // command lines by their CLI-token label, hosted assistants by their MCP
    // connection label. Empty means they have not connected anywhere yet, which is
    // what the web app uses to decide whether to nudge them. Deduped, because the
    // same app on two machines is still that app, whichever way it connected.
    const connectedApps = [
      ...new Set(
        [
          ...auth.listApiTokens(user.id).map((token) => token.label?.trim()),
          ...auth.listMcpConnections(user.id).map((connection) => connection.label.trim()),
        ].filter((label): label is string => Boolean(label)),
      ),
    ];

    return c.json({
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      createdAt: user.createdAt,
      connectedApps,
    });
  });

  /** Sign out of this browser. */
  app.post('/api/auth/sign-out', (c) => {
    const token = readSessionCookie(c);
    if (token) auth.revokeSession(token);
    clearSessionCookie(c, config);
    return c.json({ signedOut: true });
  });

  /** `open-artifact logout`: throws away the token this request is using. */
  app.post('/api/auth/token/revoke', requireUser, (c) => {
    const header = c.req.header('authorization') ?? '';
    if (!header.startsWith('Bearer ')) {
      throw new ApiError(
        'validation_failed',
        'This endpoint revokes the API token the request was made with. Send one.',
      );
    }
    auth.revokeApiToken(header.slice('Bearer '.length).trim());
    return c.body(null, 204);
  });

  // -------------------------------------------------------------------------
  // Sessions and tokens
  // -------------------------------------------------------------------------

  /**
   * Everywhere this account is signed in. Shown so somebody can see what has
   * access and take it away, which is the only recourse when a laptop goes
   * missing or an agent is set up somewhere it should not have been.
   */
  app.get('/api/auth/sessions', requireUser, (c) => {
    const user = currentUser(c);
    const currentSessionToken = readSessionCookie(c);

    return c.json({
      sessions: auth.listSessions(user.id).map((session) => ({
        id: session.id,
        label: session.label,
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
        expiresAt: session.expiresAt,
        // So the UI can say "this browser" and warn before signing itself out.
        isCurrent:
          currentSessionToken !== undefined &&
          auth.sessionIdForToken(currentSessionToken) === session.id,
      })),
      tokens: auth.listApiTokens(user.id).map((token) => ({
        id: token.id,
        label: token.label,
        createdAt: token.createdAt,
        lastUsedAt: token.lastUsedAt,
        expiresAt: token.expiresAt,
      })),
      // Hosted assistants connected over MCP, kept apart from CLI tokens so the UI
      // can label them by product and revoke the connection rather than a token.
      mcpConnections: auth.listMcpConnections(user.id).map((connection) => ({
        id: connection.id,
        label: connection.label,
        kind: 'mcp' as const,
        createdAt: connection.createdAt,
      })),
    });
  });

  /**
   * Connect a hosted assistant: mint a personal MCP token and the connection it
   * belongs to. The token is shown once and never again, the same as a password
   * would be, because only its hash is kept.
   */
  app.post('/api/auth/mcp-tokens', requireUser, async (c) => {
    const user = currentUser(c);
    const body = await readJson(c.req.raw);
    const label = typeof body.label === 'string' ? body.label.trim() : '';
    if (label.length === 0) {
      throw new ApiError('validation_failed', 'label is required. Name the assistant you are connecting.');
    }

    const issued = auth.mintMcpToken(user.id, label);
    return c.json(
      {
        token: issued.token,
        connectionId: issued.connectionId,
        label: issued.label,
        expiresAt: issued.expiresAt,
      },
      201,
    );
  });

  /** Disconnect a hosted assistant. Its tokens stop working with it. */
  app.delete('/api/auth/mcp-connections/:id', requireUser, (c) => {
    if (!auth.revokeMcpConnection(currentUser(c).id, c.req.param('id'))) {
      throw new ApiError('not_found', 'No such connection.');
    }
    return c.body(null, 204);
  });

  /** Sign a browser out, from another browser. */
  app.delete('/api/auth/sessions/:id', requireUser, (c) => {
    if (!auth.revokeSessionById(currentUser(c).id, c.req.param('id'))) {
      throw new ApiError('not_found', 'No such session.');
    }
    return c.body(null, 204);
  });

  /** Take a command line's access away. */
  app.delete('/api/auth/tokens/:id', requireUser, (c) => {
    if (!auth.revokeApiTokenById(currentUser(c).id, c.req.param('id'))) {
      throw new ApiError('not_found', 'No such token.');
    }
    return c.body(null, 204);
  });
}

/**
 * Google sign-in is optional. When an instance has no credentials set, the login
 * page shows email codes only and these routes say so plainly rather than failing
 * in a way that looks like a bug.
 */
function requireGoogleConfigured(context: AppContext): GoogleConfig {
  if (context.config.google === null) {
    throw new ApiError(
      'not_found',
      'This instance does not offer Google sign-in. Use a sign-in code instead.',
    );
  }
  return context.config.google;
}

/**
 * Only ever redirect to a path on this instance. An open redirect here would let
 * someone start a sign-in that drops the person on a page they control once it
 * finishes, wearing our domain in the address bar on the way.
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
