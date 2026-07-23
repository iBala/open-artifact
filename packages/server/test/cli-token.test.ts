import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTestServer,
  jsonBody,
  signIn,
  signInCodeFor,
  type TestServer,
} from './helpers/server.js';

/**
 * Signing in from the command line.
 *
 * The terminal gets the same emailed code the website uses, and hands it back
 * here for a token instead of a browser session. These check that the token is
 * real, that it is refused for a wrong or reused code, and that it is not a cookie.
 */

let server: TestServer;

beforeEach(() => {
  server = createTestServer({ SIGNUP_MODE: 'open' });
});

afterEach(() => {
  server.close();
});

const sendCode = (email: string) => server.request('/api/auth/code', jsonBody({ email }));

const exchange = (email: string, code: string, label?: string) =>
  server.request('/api/auth/cli-token', jsonBody({ email, code, ...(label ? { label } : {}) }));

describe('exchanging an emailed code for a token', () => {
  it('returns a token that actually authenticates, and sets no cookie', async () => {
    await sendCode('dev@example.com');
    const response = await exchange('dev@example.com', signInCodeFor(server, 'dev@example.com'), 'macOS terminal');

    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toBeNull();

    const body = (await response.json()) as {
      token: string;
      email: string;
      expiresAt: string;
      isNewAccount: boolean;
    };
    expect(body.email).toBe('dev@example.com');
    expect(body.isNewAccount).toBe(true);
    expect(body.token).toMatch(/.+/);
    expect(body.expiresAt).toMatch(/\d{4}-\d{2}-\d{2}/);

    // The token works as a bearer credential on an authenticated route.
    const me = await server.request('/api/auth/me', {
      headers: { Authorization: `Bearer ${body.token}` },
    });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { email: string }).email).toBe('dev@example.com');
  });

  it('refuses a wrong code with the same message the website gives', async () => {
    await sendCode('dev@example.com');
    const response = await exchange('dev@example.com', '000000');
    expect(response.status).toBe(401);
  });

  it('spends the code once, so a second exchange with it fails', async () => {
    await sendCode('dev@example.com');
    const code = signInCodeFor(server, 'dev@example.com');

    expect((await exchange('dev@example.com', code)).status).toBe(200);
    expect((await exchange('dev@example.com', code)).status).toBe(401);
  });

  it('reports which apps are connected, command line or hosted, so the web can stop nudging', async () => {
    const web = await signIn(server, 'dev@example.com');

    // Before connecting anything, the account reports no apps.
    const before = (await (await web.as('/api/auth/me')).json()) as { connectedApps: string[] };
    expect(before.connectedApps).toEqual([]);

    // Connect two command lines, one of them from two machines: still two apps.
    for (const label of ['Claude Code', 'Cursor', 'Claude Code']) {
      await sendCode('dev@example.com');
      await exchange('dev@example.com', signInCodeFor(server, 'dev@example.com'), label);
    }

    // Connect a hosted assistant over MCP: it counts too, by its product label.
    await web.as('/api/auth/mcp-tokens', jsonBody({ label: 'Claude on the web' }));

    const after = (await (await web.as('/api/auth/me')).json()) as { connectedApps: string[] };
    expect([...after.connectedApps].sort()).toEqual(['Claude Code', 'Claude on the web', 'Cursor']);
  });

  it('labels the token so it is recognisable on the sessions page', async () => {
    await sendCode('dev@example.com');
    const token = ((await (await exchange(
      'dev@example.com',
      signInCodeFor(server, 'dev@example.com'),
      'work laptop',
    )).json()) as { token: string }).token;

    const sessions = await server.request('/api/auth/sessions', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await sessions.json()) as { tokens?: { label: string | null }[] };
    const labels = (body.tokens ?? []).map((t) => t.label);
    expect(labels).toContain('work laptop');
  });
});
