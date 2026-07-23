import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTestServer,
  jsonBody,
  signIn,
  type TestServer,
  type SignedInUser,
} from './helpers/server.js';

/**
 * Discovery is exact, or a connector fails silently.
 *
 * A browser assistant learns the whole flow by fetching two metadata documents
 * and reading their fields. If `resource` is not exactly this instance's /mcp
 * URL, or the 401 does not point at the metadata, the connector decides there is
 * nothing here — with no error anyone sees. So these pin the exact paths, the
 * exact values, and the header a 401 must carry.
 */

let server: TestServer;

beforeEach(() => {
  server = createTestServer({ SIGNUP_MODE: 'open' });
});

afterEach(() => {
  server.close();
});

describe('protected-resource metadata', () => {
  it('lives at the path-aware well-known location for /mcp', async () => {
    const res = await server.request('/.well-known/oauth-protected-resource/mcp');
    expect(res.status).toBe(200);
  });

  it('names the resource as exactly this instance’s /mcp URL', async () => {
    const res = await server.request('/.well-known/oauth-protected-resource/mcp');
    const body = (await res.json()) as { resource: string; authorization_servers: string[] };

    expect(body.resource).toBe(`${server.config.baseUrl}/mcp`);
    expect(body.authorization_servers).toEqual([server.config.baseUrl]);
  });
});

describe('authorization-server metadata', () => {
  it('lives at the standard well-known location', async () => {
    const res = await server.request('/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
  });

  it('advertises PKCE S256 only, the two grants, code responses and offline_access', async () => {
    const res = await server.request('/.well-known/oauth-authorization-server');
    const body = (await res.json()) as Record<string, string[] | string>;

    expect(body.issuer).toBe(server.config.baseUrl);
    expect(body.authorization_endpoint).toBe(`${server.config.baseUrl}/oauth/authorize`);
    expect(body.token_endpoint).toBe(`${server.config.baseUrl}/oauth/token`);
    expect(body.registration_endpoint).toBe(`${server.config.baseUrl}/oauth/register`);
    expect(body.code_challenge_methods_supported).toEqual(['S256']);
    expect(body.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
    expect(body.response_types_supported).toEqual(['code']);
    expect(body.scopes_supported).toContain('offline_access');
  });
});

describe('the 401 that starts the dance', () => {
  it('points an unauthenticated /mcp caller at the protected-resource metadata', async () => {
    const res = await server.request('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });

    expect(res.status).toBe(401);
    const header = res.headers.get('WWW-Authenticate');
    expect(header).toContain('Bearer');
    expect(header).toContain(
      `resource_metadata="${server.config.baseUrl}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  it('is never seen by a header-token client that sends a valid token', async () => {
    const owner: SignedInUser = await signIn(server, 'owner@example.com');
    const token = (
      (await (await owner.as('/api/auth/mcp-tokens', jsonBody({ label: 'Claude Code' }))).json()) as {
        token: string;
      }
    ).token;

    const res = await server.request('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('WWW-Authenticate')).toBeNull();
  });
});
