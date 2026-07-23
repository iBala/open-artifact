/**
 * OAuth for hosted assistants that speak nothing but a URL.
 *
 * Claude on the web and ChatGPT connect through their connector screens, which
 * offer no way to paste a header token. So they run the OAuth dance: register a
 * client, send the person to a consent page, exchange a short code for tokens,
 * and refresh those tokens forever after. This service owns the moving parts of
 * that dance — clients, authorization codes, and rotating refresh tokens — and
 * leans on AuthService for the connections and access tokens, which are the same
 * kind a personal MCP token uses so `/mcp` never learns the difference.
 *
 * Two rules carry the security of the whole thing, both from MCP_DESIGN.md:
 *
 * 1. PKCE (S256 only). A stolen authorization code is worthless without the
 *    verifier the real client holds and never sent.
 * 2. Refresh reuse is fatal, no grace. A rotating refresh token is single use;
 *    presenting a spent one means two parties hold what only one should, so the
 *    connection is killed and the client must re-authorise. A dropped response
 *    costs a rare reconnect, which is the acceptable side of the trade.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { eq, and, isNull } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import {
  oauthClients,
  oauthCodes,
  oauthRefreshTokens,
  type OAuthClientRow,
} from '../db/schema.js';
import { newId } from '../ids.js';
import { nowIso } from '../time.js';
import { generateToken, hashToken } from './tokens.js';
import { type AuthService, OAUTH_ACCESS_TOKEN_SECONDS } from './service.js';

/** How long an authorization code lives. Long enough for a redirect and one
 *  token call, short enough that a leaked code is almost never still redeemable. */
export const OAUTH_CODE_SECONDS = 60;

/**
 * An OAuth-shaped failure: an `error` code from the RFC, a human description, and
 * the status to answer with. The routes render these as `{ error, error_description }`
 * bodies, which is what a connector reads to decide what went wrong.
 */
export class OAuthError extends Error {
  constructor(
    readonly error: string,
    readonly description: string,
    readonly status = 400,
  ) {
    super(description);
    this.name = 'OAuthError';
  }
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
  /** The resource bound to the tokens, echoed back so a caller can confirm it. */
  resource: string | null;
}

export interface OAuthServiceOptions {
  db: Db;
  auth: AuthService;
}

export class OAuthService {
  private readonly db: Db;
  private readonly auth: AuthService;

  constructor({ db, auth }: OAuthServiceOptions) {
    this.db = db;
    this.auth = auth;
  }

  // -------------------------------------------------------------------------
  // Dynamic client registration (RFC 7591)
  // -------------------------------------------------------------------------

  /**
   * Registers a public client. Validates every redirect URI hard, because after
   * this the redirect is the only thing tying an authorization response to the
   * software that asked for it: a loose one is an open redirect that leaks codes.
   */
  registerClient(input: { clientName: string; redirectUris: string[] }): OAuthClientRow {
    const clientName = input.clientName.trim();
    if (clientName.length === 0) {
      throw new OAuthError('invalid_client_metadata', 'client_name is required.');
    }
    if (input.redirectUris.length === 0) {
      throw new OAuthError('invalid_redirect_uri', 'At least one redirect_uri is required.');
    }
    for (const uri of input.redirectUris) {
      assertValidRedirectUri(uri);
    }

    const client: OAuthClientRow = {
      id: newId('oac'),
      clientName: clientName.slice(0, 200),
      redirectUris: JSON.stringify(input.redirectUris),
      createdAt: nowIso(),
    };
    this.db.insert(oauthClients).values(client).run();
    return client;
  }

  findClient(clientId: string): OAuthClientRow | undefined {
    return this.db.select().from(oauthClients).where(eq(oauthClients.id, clientId)).get();
  }

  /** The parsed redirect list for a client, or an empty list if it is unknown. */
  redirectUrisOf(client: OAuthClientRow): string[] {
    try {
      const parsed: unknown = JSON.parse(client.redirectUris);
      return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
    } catch {
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // Authorization codes
  // -------------------------------------------------------------------------

  /**
   * Mints an authorization code for a consent that just happened. The connection
   * already exists (the consent handler made it), so the code carries the id of
   * the connection its tokens will hang off — which is what lets a replay of the
   * spent code revoke that connection whole.
   */
  issueAuthorizationCode(input: {
    clientId: string;
    userId: string;
    connectionId: string;
    redirectUri: string;
    codeChallenge: string;
    resource: string | null;
  }): string {
    const code = generateToken();
    this.db
      .insert(oauthCodes)
      .values({
        id: newId('oco'),
        codeHash: hashToken(code),
        clientId: input.clientId,
        userId: input.userId,
        connectionId: input.connectionId,
        redirectUri: input.redirectUri,
        codeChallenge: input.codeChallenge,
        resource: input.resource,
        createdAt: nowIso(),
        expiresAt: new Date(Date.now() + OAUTH_CODE_SECONDS * 1000).toISOString(),
      })
      .run();
    return code;
  }

  /**
   * Exchanges an authorization code for tokens, once. A replayed (already-spent)
   * code does not merely fail: it revokes the connection and everything issued
   * from it, because a second holder of the code is a second holder of the grant.
   */
  exchangeAuthorizationCode(input: {
    code: string;
    clientId: string;
    redirectUri: string;
    codeVerifier: string;
  }): IssuedTokens {
    const record = this.db
      .select()
      .from(oauthCodes)
      .where(eq(oauthCodes.codeHash, hashToken(input.code)))
      .get();

    if (!record) {
      throw new OAuthError('invalid_grant', 'That authorization code is not valid.');
    }
    if (record.usedAt !== null) {
      // A spent code presented again. Someone has a copy of a code that already
      // minted tokens; burn the whole connection rather than just refusing.
      this.auth.revokeMcpConnectionById(record.connectionId);
      throw new OAuthError('invalid_grant', 'That authorization code was already used.');
    }
    if (record.expiresAt <= nowIso()) {
      throw new OAuthError('invalid_grant', 'That authorization code has expired.');
    }
    if (record.clientId !== input.clientId) {
      throw new OAuthError('invalid_grant', 'That authorization code was issued to a different client.');
    }
    if (record.redirectUri !== input.redirectUri) {
      throw new OAuthError('invalid_grant', 'The redirect_uri does not match the one the code was issued for.');
    }
    if (!verifyPkce(input.codeVerifier, record.codeChallenge)) {
      throw new OAuthError('invalid_grant', 'The PKCE verifier does not match the challenge.');
    }

    // Spend the code, atomically. If another request spent it between our read
    // and here, that is a concurrent redemption of a single-use code: revoke.
    const spent = this.db
      .update(oauthCodes)
      .set({ usedAt: nowIso() })
      .where(and(eq(oauthCodes.id, record.id), isNull(oauthCodes.usedAt)))
      .run();
    if (spent.changes === 0) {
      this.auth.revokeMcpConnectionById(record.connectionId);
      throw new OAuthError('invalid_grant', 'That authorization code was already used.');
    }

    return this.mintFamily(record.connectionId, record.userId, record.clientId, record.resource);
  }

  // -------------------------------------------------------------------------
  // Refresh tokens
  // -------------------------------------------------------------------------

  /**
   * Rotates a refresh token: retires the one presented and issues a fresh access
   * and refresh pair. Presenting a spent one is theft — kill the connection.
   */
  refreshTokens(input: { refreshToken: string; clientId: string }): IssuedTokens {
    const record = this.db
      .select()
      .from(oauthRefreshTokens)
      .where(eq(oauthRefreshTokens.tokenHash, hashToken(input.refreshToken)))
      .get();

    if (!record) {
      throw new OAuthError('invalid_grant', 'That refresh token is not valid.');
    }
    if (record.revokedAt !== null) {
      // The connection is already gone. Refuse, but do not treat it as reuse:
      // revocation is not the same event as a client replaying a live token.
      throw new OAuthError('invalid_grant', 'That connection has been disconnected. Reconnect to continue.');
    }
    if (record.usedAt !== null) {
      this.auth.revokeMcpConnectionById(record.connectionId);
      throw new OAuthError('invalid_grant', 'That refresh token was already used. The connection has been closed for safety; reconnect to continue.');
    }
    if (record.clientId !== input.clientId) {
      throw new OAuthError('invalid_grant', 'That refresh token was issued to a different client.');
    }

    const connection = this.auth.findMcpConnection(record.connectionId);
    if (!connection || connection.revokedAt !== null) {
      throw new OAuthError('invalid_grant', 'That connection has been disconnected. Reconnect to continue.');
    }

    // Retire it, atomically. A race here is two holders of one refresh token,
    // which is exactly the reuse this rule exists to punish.
    const spent = this.db
      .update(oauthRefreshTokens)
      .set({ usedAt: nowIso() })
      .where(and(eq(oauthRefreshTokens.id, record.id), isNull(oauthRefreshTokens.usedAt)))
      .run();
    if (spent.changes === 0) {
      this.auth.revokeMcpConnectionById(record.connectionId);
      throw new OAuthError('invalid_grant', 'That refresh token was already used. The connection has been closed for safety; reconnect to continue.');
    }

    return this.mintFamily(record.connectionId, connection.userId, record.clientId, record.resource);
  }

  /** Issues an access token and a fresh refresh token for a connection. */
  private mintFamily(
    connectionId: string,
    userId: string,
    clientId: string,
    resource: string | null,
  ): IssuedTokens {
    const access = this.auth.issueMcpAccessToken(connectionId, userId, resource);
    const refreshToken = generateToken();
    this.db
      .insert(oauthRefreshTokens)
      .values({
        id: newId('ort'),
        tokenHash: hashToken(refreshToken),
        connectionId,
        clientId,
        resource,
        createdAt: nowIso(),
      })
      .run();

    return {
      accessToken: access.token,
      refreshToken,
      expiresIn: OAUTH_ACCESS_TOKEN_SECONDS,
      resource,
    };
  }
}

// ---------------------------------------------------------------------------
// PKCE and redirect validation
// ---------------------------------------------------------------------------

/** True when base64url(sha256(verifier)) equals the stored challenge, compared
 *  without a timing signal. S256 is the only method this server supports. */
function verifyPkce(verifier: string, challenge: string): boolean {
  if (typeof verifier !== 'string' || verifier.length < 43 || verifier.length > 128) return false;
  const computed = createHash('sha256').update(verifier).digest('base64url');
  const a = Buffer.from(computed);
  const b = Buffer.from(challenge);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Refuses a redirect URI that is not safe to send a code to.
 *
 * https everywhere, with one exception: http is allowed only for a loopback
 * address, which is how a native client on the same machine receives the code
 * without a certificate. A wildcard host is refused outright — it would let a
 * code land on any subdomain — and so is anything that is not a URL at all.
 */
export function assertValidRedirectUri(uri: string): void {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw new OAuthError('invalid_redirect_uri', `"${uri}" is not a valid redirect URI.`);
  }
  if (url.hostname.includes('*')) {
    throw new OAuthError('invalid_redirect_uri', 'A wildcard host is not allowed in a redirect URI.');
  }
  if (url.protocol === 'https:') return;
  if (url.protocol === 'http:' && isLoopback(url.hostname)) return;
  throw new OAuthError(
    'invalid_redirect_uri',
    'A redirect URI must use https, or http only for a loopback address.',
  );
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}
