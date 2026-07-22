/**
 * Signing in with Google.
 *
 * The standard authorisation code flow. What we want from Google is one thing: a
 * verified email address. That address is the identity, so someone who signs in
 * with Google lands on the same account as someone who used an email link.
 *
 * A note on why we do not verify the id_token's signature. The token is not
 * accepted from the browser. It arrives in our own direct HTTPS response from
 * Google's token endpoint, in exchange for a code and our client secret. TLS and
 * the secret are what make that response trustworthy; a signature check on top
 * would be checking Google's word against Google's word. This is what Google's own
 * guidance says. It would be a serious mistake to start accepting an id_token from
 * anywhere else on the strength of this comment.
 */

import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import type { GoogleConfig } from '../config.js';
import { ApiError } from '../errors.js';

export interface GoogleIdentity {
  email: string;
  emailVerified: boolean;
  displayName: string | null;
}

/** Swapped out in tests so no test ever talks to Google. */
export interface GoogleClient {
  exchangeCode(code: string, redirectUri: string): Promise<GoogleIdentity>;
}

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

export function createGoogleClient(config: GoogleConfig): GoogleClient {
  return {
    async exchangeCode(code, redirectUri) {
      const response = await fetch(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: config.clientId,
          client_secret: config.clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }),
      });

      if (!response.ok) {
        throw new ApiError(
          'unauthenticated',
          'Google would not complete the sign-in. Try again, or use an email link instead.',
        );
      }

      const body = (await response.json()) as { id_token?: string };
      if (!body.id_token) {
        throw new ApiError('unauthenticated', 'Google did not return an identity token.');
      }

      const claims = decodeIdTokenPayload(body.id_token);
      if (!claims.email) {
        throw new ApiError(
          'unauthenticated',
          'Google did not share an email address, which is what this instance signs you in with.',
        );
      }

      return {
        email: claims.email,
        emailVerified: claims.email_verified === true || claims.email_verified === 'true',
        displayName: claims.name ?? null,
      };
    },
  };
}

interface IdTokenClaims {
  email?: string;
  email_verified?: boolean | string;
  name?: string;
}

/** Reads the payload of a token that already arrived over a trusted channel. */
function decodeIdTokenPayload(idToken: string): IdTokenClaims {
  const payload = idToken.split('.')[1];
  if (!payload) throw new ApiError('unauthenticated', 'Google returned a malformed token.');
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as IdTokenClaims;
  } catch {
    throw new ApiError('unauthenticated', 'Google returned a token we could not read.');
  }
}

/** The URL to send someone to when they click "Continue with Google". */
export function buildAuthorisationUrl(input: {
  config: GoogleConfig;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set('client_id', input.config.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', input.state);
  // Ask every time rather than silently reusing a previous grant, so a shared
  // computer does not sign someone in as whoever used it last.
  url.searchParams.set('prompt', 'select_account');
  return url.toString();
}

// ---------------------------------------------------------------------------
// The state parameter
// ---------------------------------------------------------------------------

/**
 * State carries where the person was headed, and proves the callback belongs to a
 * sign-in this server started. Signed with the instance secret and held in a
 * short-lived cookie, so it needs no table and cannot be forged.
 *
 * Without this, someone could feed a person a callback URL carrying their own
 * authorisation code and quietly sign that person into the attacker's account.
 */
export function signState(secret: string, redirectTo: string | null): string {
  const nonce = randomBytes(16).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ nonce, redirectTo }), 'utf8').toString('base64url');
  return `${payload}.${sign(secret, payload)}`;
}

export function verifyState(secret: string, state: string): { redirectTo: string | null } {
  const [payload, signature] = state.split('.');
  if (!payload || !signature) {
    throw new ApiError('unauthenticated', 'This sign-in could not be completed. Start again.');
  }

  const expected = sign(secret, payload);
  const given = Buffer.from(signature, 'utf8');
  const want = Buffer.from(expected, 'utf8');
  if (given.length !== want.length || !timingSafeEqual(given, want)) {
    throw new ApiError('unauthenticated', 'This sign-in could not be completed. Start again.');
  }

  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      redirectTo: string | null;
    };
    return { redirectTo: decoded.redirectTo ?? null };
  } catch {
    throw new ApiError('unauthenticated', 'This sign-in could not be completed. Start again.');
  }
}

function sign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}
