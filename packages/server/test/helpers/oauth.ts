/**
 * Driving the OAuth dance from a test, the way a real connector would: register,
 * consent through the server-rendered page, exchange the code, refresh. Nothing
 * is faked — these helpers speak the same HTTP the connector screens speak, so a
 * test that uses them also covers the flow itself.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { TestServer, SignedInUser } from './server.js';

export const REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback';
export const CLIENT_NAME = 'Claude on the web';

/** A PKCE verifier and its S256 challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url'); // 43 chars, within range
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function mcpResource(server: TestServer): string {
  return `${server.config.baseUrl}/mcp`;
}

export interface RegisteredClient {
  clientId: string;
  redirectUris: string[];
}

export async function registerClient(
  server: TestServer,
  body: Record<string, unknown> = { client_name: CLIENT_NAME, redirect_uris: [REDIRECT_URI] },
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await server.request('/oauth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

export async function registerOk(server: TestServer): Promise<RegisteredClient> {
  const { status, json } = await registerClient(server);
  if (status !== 201) throw new Error(`registration failed: ${status} ${JSON.stringify(json)}`);
  return { clientId: json.client_id as string, redirectUris: json.redirect_uris as string[] };
}

export interface AuthorizeInput {
  clientId: string;
  challenge: string;
  state?: string;
  resource?: string;
  redirectUri?: string;
  responseType?: string;
  challengeMethod?: string;
}

export function authorizeQuery(input: AuthorizeInput): URLSearchParams {
  const q = new URLSearchParams();
  q.set('response_type', input.responseType ?? 'code');
  q.set('client_id', input.clientId);
  q.set('redirect_uri', input.redirectUri ?? REDIRECT_URI);
  q.set('code_challenge', input.challenge);
  q.set('code_challenge_method', input.challengeMethod ?? 'S256');
  if (input.state) q.set('state', input.state);
  if (input.resource) q.set('resource', input.resource);
  return q;
}

/** Reads the CSRF token the consent page put in its form. */
function csrfFrom(html: string): string {
  const match = /name="csrf" value="([^"]+)"/.exec(html);
  if (!match) throw new Error('no csrf token on the consent page');
  return match[1] ?? '';
}

/**
 * Consents as this person and returns the redirect the connector was sent to.
 * `decision` defaults to approve; pass 'deny' to refuse.
 */
export async function consent(
  server: TestServer,
  user: SignedInUser,
  input: AuthorizeInput,
  decision: 'approve' | 'deny' = 'approve',
): Promise<{ status: number; location: string | null; code: string | null; error: string | null; state: string | null }> {
  const q = authorizeQuery(input);
  const page = await user.as(`/oauth/authorize?${q.toString()}`);
  const html = await page.text();
  const csrf = csrfFrom(html);

  const form = new URLSearchParams(q);
  form.set('csrf', csrf);
  form.set('decision', decision);

  const res = await user.as('/oauth/authorize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const location = res.headers.get('location');
  const url = location ? new URL(location) : null;
  return {
    status: res.status,
    location,
    code: url?.searchParams.get('code') ?? null,
    error: url?.searchParams.get('error') ?? null,
    state: url?.searchParams.get('state') ?? null,
  };
}

export async function exchangeCode(
  server: TestServer,
  input: { code: string; verifier: string; clientId: string; redirectUri?: string },
): Promise<{ status: number; json: Record<string, unknown> }> {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    client_id: input.clientId,
    redirect_uri: input.redirectUri ?? REDIRECT_URI,
    code_verifier: input.verifier,
  });
  const res = await server.request('/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

export async function refresh(
  server: TestServer,
  input: { refreshToken: string; clientId: string },
): Promise<{ status: number; json: Record<string, unknown> }> {
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: input.refreshToken,
    client_id: input.clientId,
  });
  const res = await server.request('/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

/** Calls /mcp with a bearer access token and returns the raw response. */
export function mcpCall(server: TestServer, accessToken: string, message: unknown): Promise<Response> {
  return server.request('/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(message),
  });
}

/** The whole connect, end to end: register, consent, exchange. */
export async function connectFully(
  server: TestServer,
  user: SignedInUser,
  opts: { resource?: string; state?: string } = {},
): Promise<{
  clientId: string;
  accessToken: string;
  refreshToken: string;
  verifier: string;
}> {
  const { clientId } = await registerOk(server);
  const { verifier, challenge } = pkcePair();
  const consented = await consent(server, user, {
    clientId,
    challenge,
    state: opts.state,
    resource: opts.resource,
  });
  if (!consented.code) throw new Error(`consent produced no code: ${consented.location}`);
  const exchanged = await exchangeCode(server, { code: consented.code, verifier, clientId });
  if (exchanged.status !== 200) {
    throw new Error(`exchange failed: ${exchanged.status} ${JSON.stringify(exchanged.json)}`);
  }
  return {
    clientId,
    accessToken: exchanged.json.access_token as string,
    refreshToken: exchanged.json.refresh_token as string,
    verifier,
  };
}
