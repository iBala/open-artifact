import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestServer, type TestServer } from './helpers/server.js';
import { registerClient, REDIRECT_URI } from './helpers/oauth.js';

/**
 * Dynamic client registration (RFC 7591).
 *
 * After registration the redirect URI is the only thing tying an authorization
 * response back to the software that asked for it, so a loose one is an open
 * redirect that leaks codes. These pin the refusals: a wildcard host, an
 * http redirect that is not loopback, a missing list.
 */

let server: TestServer;

beforeEach(() => {
  server = createTestServer({ SIGNUP_MODE: 'open' });
});

afterEach(() => {
  server.close();
});

describe('registering a connector', () => {
  it('accepts a name and an https redirect, and hands back a public-client record', async () => {
    const { status, json } = await registerClient(server);

    expect(status).toBe(201);
    expect(json.client_id).toMatch(/^oac_/);
    expect(json.client_name).toBe('Claude on the web');
    expect(json.redirect_uris).toEqual([REDIRECT_URI]);
    expect(json.token_endpoint_auth_method).toBe('none');
    expect(json.grant_types).toEqual(['authorization_code', 'refresh_token']);
  });

  it('allows http only for a loopback address', async () => {
    const loopback = await registerClient(server, {
      client_name: 'A native client',
      redirect_uris: ['http://127.0.0.1:8976/callback'],
    });
    expect(loopback.status).toBe(201);
  });
});

describe('registrations it refuses', () => {
  it('refuses a wildcard host', async () => {
    const { status, json } = await registerClient(server, {
      client_name: 'Sneaky',
      redirect_uris: ['https://*.evil.example/callback'],
    });
    expect(status).toBe(400);
    expect(json.error).toBe('invalid_redirect_uri');
  });

  it('refuses a plain http redirect that is not loopback', async () => {
    const { status, json } = await registerClient(server, {
      client_name: 'Cleartext',
      redirect_uris: ['http://evil.example/callback'],
    });
    expect(status).toBe(400);
    expect(json.error).toBe('invalid_redirect_uri');
  });

  it('refuses an empty redirect list', async () => {
    const { status, json } = await registerClient(server, {
      client_name: 'No redirect',
      redirect_uris: [],
    });
    expect(status).toBe(400);
    expect(json.error).toBe('invalid_redirect_uri');
  });

  it('refuses a missing redirect list', async () => {
    const { status } = await registerClient(server, { client_name: 'No redirect field' });
    expect(status).toBe(400);
  });

  it('refuses a missing name', async () => {
    const { status, json } = await registerClient(server, { redirect_uris: [REDIRECT_URI] });
    expect(status).toBe(400);
    expect(json.error).toBe('invalid_client_metadata');
  });

  it('refuses something that is not a URL at all', async () => {
    const { status } = await registerClient(server, {
      client_name: 'Nonsense',
      redirect_uris: ['not a url'],
    });
    expect(status).toBe(400);
  });
});

describe('the registration rate limit', () => {
  it('stops answering after a burst from one address', async () => {
    // The limit is 20 an hour, so the 21st is refused.
    let lastStatus = 201;
    for (let i = 0; i < 25; i += 1) {
      const res = await server.request('/oauth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
        body: JSON.stringify({ client_name: `Client ${i}`, redirect_uris: [REDIRECT_URI] }),
      });
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
  });
});
