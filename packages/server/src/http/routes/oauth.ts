/**
 * The OAuth surface a browser assistant connects through.
 *
 * Five kinds of endpoint, all public except the consent page, which is the one
 * OAuth piece that reads the session cookie because it is a page a person looks
 * at:
 *
 *   /.well-known/oauth-protected-resource/mcp  what protects /mcp (RFC 9728)
 *   /.well-known/oauth-authorization-server    who issues its tokens (RFC 8414)
 *   POST /oauth/register                       a connector registers (RFC 7591)
 *   GET  /oauth/authorize                       consent, or a bounce to sign-in
 *   POST /oauth/authorize                       the person's decision
 *   POST /oauth/token                           code → tokens, refresh → tokens
 *
 * Everything here is exact on purpose. A connector discovers the flow by fetching
 * the two metadata documents and reading the fields; get a path or a value
 * slightly wrong and discovery fails with no error anyone sees. So the resource
 * is exactly `<baseUrl>/mcp`, the challenge method is S256 and nothing else, and
 * the consent page never approves on its own.
 *
 * The consent page is server-rendered rather than a web-app route, like the
 * device-approval page: it has to work as a plain page reached straight from a
 * redirect, before any app has loaded, and it is the screen where a person hands
 * a third party the ability to act as them — clarity matters more than polish.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Context, Hono } from 'hono';
import type { AppContext, AppEnv } from '../app.js';
import { readTextWithin } from '../body.js';
import { addressOf } from '../rate-limit.js';
import { readSessionCookie } from '../cookies.js';
import { escapeHtml } from '../../render/escape.js';
import { OAuthError } from '../../auth/oauth.js';

/** A registration or token body is tiny; anything larger is not a real client. */
const OAUTH_BODY_CAP_BYTES = 64 * 1024;

/** Client registrations per address before the endpoint stops answering. */
const OAUTH_REGISTER_LIMIT = { limit: 20, windowSeconds: 3600 };

export function registerOAuthRoutes(app: Hono<AppEnv>, context: AppContext): void {
  const { config, auth, oauth, rateLimiter } = context;
  const baseUrl = config.baseUrl;
  const mcpResource = `${baseUrl}/mcp`;

  // -------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------

  /**
   * Protected-resource metadata (RFC 9728). Served at the path-aware location for
   * the `/mcp` resource so a connector that read the `resource_metadata` hint on a
   * 401 lands here. `resource` is exactly `<baseUrl>/mcp`; anything else and the
   * connector decides this is a different resource and gives up.
   */
  app.get('/.well-known/oauth-protected-resource/mcp', (c) =>
    c.json({
      resource: mcpResource,
      authorization_servers: [baseUrl],
      scopes_supported: ['offline_access'],
      bearer_methods_supported: ['header'],
      resource_documentation: `${baseUrl}/api/docs`,
    }),
  );

  /**
   * Authorization-server metadata (RFC 8414). Advertises exactly what this server
   * does and nothing it does not: S256 the only challenge method, code and refresh
   * the only grants, code the only response type, offline_access among the scopes
   * so a connector knows to ask for a refresh token.
   */
  app.get('/.well-known/oauth-authorization-server', (c) =>
    c.json({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/oauth/authorize`,
      token_endpoint: `${baseUrl}/oauth/token`,
      registration_endpoint: `${baseUrl}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['offline_access'],
      service_documentation: `${baseUrl}/api/docs`,
    }),
  );

  // -------------------------------------------------------------------------
  // Dynamic client registration (RFC 7591)
  // -------------------------------------------------------------------------

  app.post('/oauth/register', async (c) => {
    const retryAfter = rateLimiter.check('oauth-register', addressOf(c), OAUTH_REGISTER_LIMIT);
    if (retryAfter !== null) {
      return c.json(
        { error: 'temporarily_unavailable', error_description: 'Too many registrations. Try again later.' },
        429,
        { 'Retry-After': String(retryAfter) },
      );
    }

    let body: Record<string, unknown>;
    try {
      const raw = await readTextWithin(c.req.raw, OAUTH_BODY_CAP_BYTES);
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      body = parsed as Record<string, unknown>;
    } catch {
      return oauthErrorJson(c, new OAuthError('invalid_client_metadata', 'The registration body must be a JSON object.'));
    }

    const clientName = typeof body.client_name === 'string' ? body.client_name : '';
    const redirectUris = Array.isArray(body.redirect_uris)
      ? body.redirect_uris.filter((entry): entry is string => typeof entry === 'string')
      : [];

    try {
      const client = oauth.registerClient({ clientName, redirectUris });
      return c.json(
        {
          client_id: client.id,
          client_name: client.clientName,
          redirect_uris: oauth.redirectUrisOf(client),
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          client_id_issued_at: Math.floor(new Date(client.createdAt).getTime() / 1000),
        },
        201,
      );
    } catch (error) {
      if (error instanceof OAuthError) return oauthErrorJson(c, error);
      throw error;
    }
  });

  // -------------------------------------------------------------------------
  // Authorize + consent
  // -------------------------------------------------------------------------

  app.get('/oauth/authorize', (c) => {
    const params = new URL(c.req.url).searchParams;
    const request = readAuthorizeParams(params);

    // The client and its redirect are validated first, and a failure renders a
    // page rather than redirecting: sending an error to an unverified redirect is
    // itself the open-redirect this guards against.
    const client = oauth.findClient(request.clientId);
    if (!client) {
      return c.html(errorPage('This connector is not registered here.'), 400);
    }
    if (!request.redirectUri || !oauth.redirectUrisOf(client).includes(request.redirectUri)) {
      return c.html(errorPage('That redirect address does not match how this connector registered.'), 400);
    }

    // From here the redirect is trusted, so the rest of the failures go back to
    // the connector as OAuth errors, which is where it can act on them.
    const problem = validateAuthorizeShape(request, mcpResource);
    if (problem) {
      return redirectWithError(c, request.redirectUri, problem.error, problem.description, request.state);
    }

    // Consent needs a signed-in person. Bounce to sign-in and come straight back
    // with the whole request intact, the same mechanism the device page uses.
    const user = c.get('user');
    if (!user) {
      const back = `/oauth/authorize?${params.toString()}`;
      return c.redirect(`/login?redirectTo=${encodeURIComponent(back)}`, 302);
    }

    const csrf = consentToken(c, config.sessionSecret, auth);
    if (!csrf) {
      return c.html(errorPage('Your sign-in could not be confirmed. Sign in again and retry.'), 401);
    }

    return c.html(
      consentPage({
        clientName: client.clientName,
        email: user.email,
        instanceHost: hostOf(baseUrl),
        request,
        csrf,
      }),
    );
  });

  app.post('/oauth/authorize', async (c) => {
    const form = await readForm(c);
    const request: AuthorizeParams = {
      clientId: form.get('client_id') ?? '',
      redirectUri: form.get('redirect_uri') ?? '',
      responseType: form.get('response_type') ?? '',
      codeChallenge: form.get('code_challenge') ?? '',
      codeChallengeMethod: form.get('code_challenge_method') ?? '',
      state: form.get('state'),
      scope: form.get('scope'),
      resource: form.get('resource'),
    };

    const user = c.get('user');
    if (!user) {
      return c.html(errorPage('You are not signed in. Sign in and start the connection again.'), 401);
    }

    // CSRF: the hidden token is HMAC(secret, session). A forged cross-site post
    // carries the cookie but cannot read or compute this value.
    const expected = consentToken(c, config.sessionSecret, auth);
    const submitted = form.get('csrf') ?? '';
    if (!expected || !constantTimeEquals(expected, submitted)) {
      return c.html(errorPage('That request could not be confirmed. Start the connection again.'), 403);
    }

    // Never trust the hidden fields: re-validate the client and redirect exactly
    // as the GET did, against the registration.
    const client = oauth.findClient(request.clientId);
    if (!client) {
      return c.html(errorPage('This connector is not registered here.'), 400);
    }
    if (!request.redirectUri || !oauth.redirectUrisOf(client).includes(request.redirectUri)) {
      return c.html(errorPage('That redirect address does not match how this connector registered.'), 400);
    }
    const problem = validateAuthorizeShape(request, mcpResource);
    if (problem) {
      return redirectWithError(c, request.redirectUri, problem.error, problem.description, request.state);
    }

    if (form.get('decision') !== 'approve') {
      return redirectWithError(c, request.redirectUri, 'access_denied', 'The connection was not approved.', request.state);
    }

    // Approved. The connection is created now, labelled with the connector's name,
    // so what this grant publishes is owned by it and a revoke later names the
    // product. The code carries the connection id so a replay can burn it whole.
    const connection = auth.createMcpConnection(user.id, client.clientName);
    const code = oauth.issueAuthorizationCode({
      clientId: client.id,
      userId: user.id,
      connectionId: connection.id,
      redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge,
      resource: request.resource === mcpResource ? mcpResource : null,
    });

    const url = new URL(request.redirectUri);
    url.searchParams.set('code', code);
    if (request.state) url.searchParams.set('state', request.state);
    return c.redirect(url.toString(), 302);
  });

  // -------------------------------------------------------------------------
  // Token
  // -------------------------------------------------------------------------

  app.post('/oauth/token', async (c) => {
    const form = await readForm(c);
    const grantType = form.get('grant_type');

    try {
      let issued;
      if (grantType === 'authorization_code') {
        issued = oauth.exchangeAuthorizationCode({
          code: form.get('code') ?? '',
          clientId: form.get('client_id') ?? '',
          redirectUri: form.get('redirect_uri') ?? '',
          codeVerifier: form.get('code_verifier') ?? '',
        });
      } else if (grantType === 'refresh_token') {
        issued = oauth.refreshTokens({
          refreshToken: form.get('refresh_token') ?? '',
          clientId: form.get('client_id') ?? '',
        });
      } else {
        return oauthErrorJson(
          c,
          new OAuthError('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token.'),
        );
      }

      // no-store so a token never lands in a shared cache (RFC 6749 §5.1).
      c.header('Cache-Control', 'no-store');
      return c.json({
        access_token: issued.accessToken,
        token_type: 'Bearer',
        expires_in: issued.expiresIn,
        refresh_token: issued.refreshToken,
        scope: 'offline_access',
      });
    } catch (error) {
      if (error instanceof OAuthError) return oauthErrorJson(c, error);
      throw error;
    }
  });
}

// ---------------------------------------------------------------------------
// Authorize request parsing and validation
// ---------------------------------------------------------------------------

interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  responseType: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  state: string | null;
  scope: string | null;
  resource: string | null;
}

function readAuthorizeParams(params: URLSearchParams): AuthorizeParams {
  return {
    clientId: params.get('client_id') ?? '',
    redirectUri: params.get('redirect_uri') ?? '',
    responseType: params.get('response_type') ?? '',
    codeChallenge: params.get('code_challenge') ?? '',
    codeChallengeMethod: params.get('code_challenge_method') ?? '',
    state: params.get('state'),
    scope: params.get('scope'),
    resource: params.get('resource'),
  };
}

/** The checks that, once the redirect is trusted, come back as OAuth errors. */
function validateAuthorizeShape(
  request: AuthorizeParams,
  mcpResource: string,
): { error: string; description: string } | null {
  if (request.responseType !== 'code') {
    return { error: 'unsupported_response_type', description: 'response_type must be code.' };
  }
  if (request.codeChallengeMethod !== 'S256') {
    return { error: 'invalid_request', description: 'code_challenge_method must be S256.' };
  }
  if (request.codeChallenge.length === 0) {
    return { error: 'invalid_request', description: 'code_challenge is required (PKCE).' };
  }
  // RFC 8707: if a resource is named it must be the one this server protects.
  if (request.resource !== null && request.resource !== mcpResource) {
    return { error: 'invalid_target', description: 'The resource is not one this server issues tokens for.' };
  }
  return null;
}

function redirectWithError(
  c: Context<AppEnv>,
  redirectUri: string,
  error: string,
  description: string,
  state: string | null,
) {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);
  url.searchParams.set('error_description', description);
  if (state) url.searchParams.set('state', state);
  return c.redirect(url.toString(), 302);
}

// ---------------------------------------------------------------------------
// Bodies, CSRF and small helpers
// ---------------------------------------------------------------------------

/** Reads an application/x-www-form-urlencoded body within the cap. */
async function readForm(c: Context<AppEnv>): Promise<URLSearchParams> {
  const raw = await readTextWithin(c.req.raw, OAUTH_BODY_CAP_BYTES);
  return new URLSearchParams(raw);
}

/**
 * The CSRF token bound to the current session: HMAC(secret, session id). Anyone
 * who can post as this person carries the cookie, but a cross-site page cannot
 * read the token out of our HTML nor compute it without the secret. Returns null
 * when there is no live session to bind to.
 */
function consentToken(c: Context<AppEnv>, secret: string, auth: AppContext['auth']): string | null {
  const cookie = readSessionCookie(c);
  if (!cookie) return null;
  const sessionId = auth.sessionIdForToken(cookie);
  if (!sessionId) return null;
  return createHmac('sha256', secret).update(`oauth-consent:${sessionId}`).digest('hex');
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function oauthErrorJson(c: Context<AppEnv>, error: OAuthError) {
  return c.json({ error: error.error, error_description: error.description }, error.status as 400);
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

// ---------------------------------------------------------------------------
// The consent page
// ---------------------------------------------------------------------------

function consentPage(input: {
  clientName: string;
  email: string;
  instanceHost: string;
  request: AuthorizeParams;
  csrf: string;
}): string {
  const hidden = (name: string, value: string | null) =>
    value === null ? '' : `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Connect ${escapeHtml(input.clientName)}</title>
<style>${STYLES}</style>
</head><body>
<main class="card">
  <h1>Connect ${escapeHtml(input.clientName)}?</h1>
  <p class="muted">
    <strong>${escapeHtml(input.clientName)}</strong> is asking to connect to
    ${escapeHtml(input.instanceHost)} as <strong>${escapeHtml(input.email)}</strong>.
    This lets it act as you from a chat with no terminal.
  </p>

  <p class="section">A connection may</p>
  <ul class="can">
    <li>Publish new documents, and update, read and list the ones it published</li>
    <li>Read the comments on those, and reply to and resolve them</li>
    <li>Share one of those with one person, by email address</li>
  </ul>

  <p class="section">A connection may not</p>
  <ul class="cannot">
    <li>Delete anything, or make a document public</li>
    <li>Share with a whole domain</li>
    <li>Read documents other people shared with you</li>
    <li>Edit or delete comments, or touch your account</li>
  </ul>

  <p class="muted small">
    You can disconnect it at any time from your sessions page, which takes its
    access away at once.
  </p>

  <form method="post" action="/oauth/authorize">
    ${hidden('client_id', input.request.clientId)}
    ${hidden('redirect_uri', input.request.redirectUri)}
    ${hidden('response_type', input.request.responseType)}
    ${hidden('code_challenge', input.request.codeChallenge)}
    ${hidden('code_challenge_method', input.request.codeChallengeMethod)}
    ${hidden('state', input.request.state)}
    ${hidden('scope', input.request.scope)}
    ${hidden('resource', input.request.resource)}
    <input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}">
    <div class="actions">
      <button type="submit" name="decision" value="approve" class="primary">Connect</button>
      <button type="submit" name="decision" value="deny" class="secondary">Cancel</button>
    </div>
  </form>
</main>
</body></html>`;
}

function errorPage(message: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Cannot connect</title>
<style>${STYLES}</style>
</head><body>
<main class="card">
  <h1>That connection could not start</h1>
  <p class="muted">${escapeHtml(message)}</p>
</main>
</body></html>`;
}

const STYLES = `
  :root { color-scheme: light dark; --edge: color-mix(in srgb, currentColor 14%, transparent); }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
         font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  .card { max-width: 460px; width: 100%; border: 1px solid var(--edge); border-radius: 14px; padding: 28px; }
  h1 { margin: 0 0 12px; font-size: 21px; letter-spacing: -0.02em; }
  .muted { margin: 0 0 16px; opacity: 0.8; font-size: 15px; }
  .muted.small { font-size: 13px; opacity: 0.65; }
  .section { margin: 18px 0 6px; font-size: 13px; font-weight: 600; text-transform: uppercase;
             letter-spacing: 0.06em; opacity: 0.7; }
  ul { margin: 0 0 8px; padding-left: 18px; font-size: 14px; }
  ul li { margin: 4px 0; }
  ul.can li::marker { content: "✓  "; }
  ul.cannot li::marker { content: "✕  "; }
  ul.cannot { opacity: 0.75; }
  .actions { display: flex; flex-direction: column; gap: 10px; margin-top: 22px; }
  button { font: inherit; padding: 11px 16px; border-radius: 9px; cursor: pointer; border: 1px solid var(--edge); }
  .primary { background: canvastext; color: canvas; border-color: transparent; font-weight: 500; }
  .secondary { background: transparent; color: inherit; }
`;
