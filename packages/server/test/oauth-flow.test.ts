import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createTestServer,
  signIn,
  type TestServer,
  type SignedInUser,
} from './helpers/server.js';
import {
  registerOk,
  pkcePair,
  authorizeQuery,
  consent,
  exchangeCode,
  refresh,
  mcpCall,
  connectFully,
  mcpResource,
  REDIRECT_URI,
  CLIENT_NAME,
} from './helpers/oauth.js';
import { apiTokens, mcpConnections, oauthCodes } from '../src/db/schema.js';
import { newId } from '../src/ids.js';
import { nowIso } from '../src/time.js';
import { hashToken, generateToken } from '../src/auth/tokens.js';

/**
 * The OAuth flow, end to end and at its sharp edges.
 *
 * The edges are where the security lives: a code is single use and a replay burns
 * the connection, a refresh token is single use and a replay burns the
 * connection, the verifier must match, and a token minted for another instance is
 * refused. The happy path proves the whole thing carries a real publish.
 */

let server: TestServer;
let owner: SignedInUser;

beforeEach(async () => {
  server = createTestServer({ SIGNUP_MODE: 'open' });
  owner = await signIn(server, 'owner@example.com');
});

afterEach(() => {
  server.close();
});

/** The connection a consent created, found by its product label. */
function connectionByLabel(label = CLIENT_NAME) {
  return server.database.db
    .select()
    .from(mcpConnections)
    .where(eq(mcpConnections.label, label))
    .get();
}

const toolsList = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };

// ---------------------------------------------------------------------------

describe('the consent page', () => {
  it('bounces a signed-out person to sign-in, keeping the whole request', async () => {
    const { clientId } = await registerOk(server);
    const { challenge } = pkcePair();
    const q = authorizeQuery({ clientId, challenge, state: 'xyz' });

    const res = await server.request(`/oauth/authorize?${q.toString()}`);
    expect(res.status).toBe(302);

    const location = res.headers.get('location') ?? '';
    expect(location.startsWith('/login?redirectTo=')).toBe(true);
    const back = decodeURIComponent(location.split('redirectTo=')[1] ?? '');
    expect(back.startsWith('/oauth/authorize?')).toBe(true);
    expect(back).toContain(`client_id=${clientId}`);
    expect(back).toContain('state=xyz');
  });

  it('never approves on its own: the signed-in page is shown, not a redirect', async () => {
    const { clientId } = await registerOk(server);
    const { challenge } = pkcePair();
    const q = authorizeQuery({ clientId, challenge });

    const res = await owner.as(`/oauth/authorize?${q.toString()}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();

    const html = await res.text();
    expect(html).toContain(CLIENT_NAME);
    // Names what a connection may and may not do.
    expect(html).toContain('Publish');
    expect(html).toContain('may not');
  });

  it('refuses an unknown client with a page, not a redirect', async () => {
    const { challenge } = pkcePair();
    const q = authorizeQuery({ clientId: 'oac_nope', challenge });
    const res = await owner.as(`/oauth/authorize?${q.toString()}`);
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
  });

  it('refuses a redirect that does not match the registration', async () => {
    const { clientId } = await registerOk(server);
    const { challenge } = pkcePair();
    const q = authorizeQuery({ clientId, challenge, redirectUri: 'https://other.example/cb' });
    const res = await owner.as(`/oauth/authorize?${q.toString()}`);
    expect(res.status).toBe(400);
  });

  it('sends a bad-shape request back to the connector as an error', async () => {
    const { clientId } = await registerOk(server);
    // No code_challenge: invalid_request, back to the trusted redirect.
    const q = authorizeQuery({ clientId, challenge: '' });
    q.delete('code_challenge');
    const res = await server.request(`/oauth/authorize?${q.toString()}`);
    expect(res.status).toBe(302);

    const location = res.headers.get('location') ?? '';
    expect(location.startsWith(REDIRECT_URI)).toBe(true);
    expect(location).toContain('error=invalid_request');
  });

  it('refuses a resource that is not this server’s', async () => {
    const { clientId } = await registerOk(server);
    const { challenge } = pkcePair();
    const q = authorizeQuery({ clientId, challenge, resource: 'https://other.example/mcp' });
    const res = await server.request(`/oauth/authorize?${q.toString()}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location') ?? '').toContain('error=invalid_target');
  });

  it('approving redirects to the connector with a code and the state', async () => {
    const { clientId } = await registerOk(server);
    const { challenge } = pkcePair();
    const result = await consent(server, owner, { clientId, challenge, state: 'abc123' });

    expect(result.status).toBe(302);
    expect(result.location?.startsWith(REDIRECT_URI)).toBe(true);
    expect(result.code).toBeTruthy();
    expect(result.state).toBe('abc123');
  });

  it('refusing redirects with access_denied and no code', async () => {
    const { clientId } = await registerOk(server);
    const { challenge } = pkcePair();
    const result = await consent(server, owner, { clientId, challenge }, 'deny');

    expect(result.code).toBeNull();
    expect(result.error).toBe('access_denied');
  });

  it('refuses a post whose CSRF token does not match the session', async () => {
    const { clientId } = await registerOk(server);
    const { challenge } = pkcePair();
    const form = new URLSearchParams(authorizeQuery({ clientId, challenge }));
    form.set('csrf', 'forged');
    form.set('decision', 'approve');

    const res = await owner.as('/oauth/authorize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------

describe('authorization codes', () => {
  it('exchanges once for an access token and a refresh token', async () => {
    const { clientId } = await registerOk(server);
    const { verifier, challenge } = pkcePair();
    const { code } = await consent(server, owner, { clientId, challenge });

    const { status, json } = await exchangeCode(server, { code: code!, verifier, clientId });
    expect(status).toBe(200);
    expect(json.access_token).toBeTruthy();
    expect(json.refresh_token).toBeTruthy();
    expect(json.token_type).toBe('Bearer');
    expect(json.expires_in).toBe(3600);
  });

  it('refuses a wrong verifier', async () => {
    const { clientId } = await registerOk(server);
    const { challenge } = pkcePair();
    const { code } = await consent(server, owner, { clientId, challenge });

    const { status, json } = await exchangeCode(server, {
      code: code!,
      verifier: pkcePair().verifier,
      clientId,
    });
    expect(status).toBe(400);
    expect(json.error).toBe('invalid_grant');
  });

  it('refuses an expired code', async () => {
    const { clientId } = await registerOk(server);
    const { verifier, challenge } = pkcePair();
    const { code } = await consent(server, owner, { clientId, challenge });

    // Push its expiry into the past, the way sixty seconds elapsing would.
    server.database.db
      .update(oauthCodes)
      .set({ expiresAt: '2000-01-01T00:00:00.000Z' })
      .run();

    const { status, json } = await exchangeCode(server, { code: code!, verifier, clientId });
    expect(status).toBe(400);
    expect(json.error).toBe('invalid_grant');
  });

  it('refuses a code presented with the wrong redirect', async () => {
    const { clientId } = await registerOk(server);
    const { verifier, challenge } = pkcePair();
    const { code } = await consent(server, owner, { clientId, challenge });

    const { status } = await exchangeCode(server, {
      code: code!,
      verifier,
      clientId,
      redirectUri: 'https://claude.ai/somewhere/else',
    });
    expect(status).toBe(400);
  });

  it('refuses a replay, and burns the connection it already issued tokens for', async () => {
    const { clientId } = await registerOk(server);
    const { verifier, challenge } = pkcePair();
    const { code } = await consent(server, owner, { clientId, challenge });

    const first = await exchangeCode(server, { code: code!, verifier, clientId });
    expect(first.status).toBe(200);
    const access = first.json.access_token as string;
    // The access token works right up until the replay.
    expect((await mcpCall(server, access, toolsList)).status).toBe(200);

    const replay = await exchangeCode(server, { code: code!, verifier, clientId });
    expect(replay.status).toBe(400);
    expect(replay.json.error).toBe('invalid_grant');

    // The connection is dead, so the token issued from that code is now refused.
    expect((await mcpCall(server, access, toolsList)).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------

describe('refresh rotation', () => {
  it('issues a new pair and retires the old refresh token', async () => {
    const { clientId, refreshToken } = await connectFully(server, owner);

    const rotated = await refresh(server, { refreshToken, clientId });
    expect(rotated.status).toBe(200);
    expect(rotated.json.access_token).toBeTruthy();
    expect(rotated.json.refresh_token).toBeTruthy();
    expect(rotated.json.refresh_token).not.toBe(refreshToken);

    // The new access token works.
    expect((await mcpCall(server, rotated.json.access_token as string, toolsList)).status).toBe(200);
  });

  it('kills the whole connection when a spent refresh token is presented again', async () => {
    const { clientId, refreshToken } = await connectFully(server, owner);

    const rotated = await refresh(server, { refreshToken, clientId });
    expect(rotated.status).toBe(200);
    const newAccess = rotated.json.access_token as string;
    expect((await mcpCall(server, newAccess, toolsList)).status).toBe(200);

    // Present the spent one again: fatal, no grace.
    const reuse = await refresh(server, { refreshToken, clientId });
    expect(reuse.status).toBe(400);
    expect(reuse.json.error).toBe('invalid_grant');

    // Everything the connection had is gone: the access token from the good
    // rotation, and the refresh token from it too.
    expect((await mcpCall(server, newAccess, toolsList)).status).toBe(401);
    const afterKill = await refresh(server, {
      refreshToken: rotated.json.refresh_token as string,
      clientId,
    });
    expect(afterKill.status).toBe(400);
  });

  it('refuses an unsupported grant type', async () => {
    const res = await server.request('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'password' }).toString(),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('unsupported_grant_type');
  });
});

// ---------------------------------------------------------------------------

describe('audience binding', () => {
  it('refuses an access token minted for another instance', async () => {
    const connection = server.database.db
      .insert(mcpConnections)
      .values({ id: newId('mcp'), userId: owner.id, label: 'Elsewhere', createdAt: nowIso(), revokedAt: null })
      .returning()
      .get();

    const foreignToken = generateToken();
    server.database.db
      .insert(apiTokens)
      .values({
        id: newId('tok'),
        userId: owner.id,
        tokenHash: hashToken(foreignToken),
        kind: 'mcp',
        connectionId: connection.id,
        resource: 'https://other-instance.example/mcp',
        createdAt: nowIso(),
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      })
      .run();

    expect((await mcpCall(server, foreignToken, toolsList)).status).toBe(401);
  });

  it('accepts an access token bound to this instance’s resource', async () => {
    const { accessToken } = await connectFully(server, owner, { resource: mcpResource(server) });
    expect((await mcpCall(server, accessToken, toolsList)).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------

describe('the connection on the sessions page', () => {
  it('lists it by the connector’s product name, and counts it as a connected app', async () => {
    await connectFully(server, owner);

    const sessions = (await (await owner.as('/api/auth/sessions')).json()) as {
      mcpConnections: { label: string }[];
    };
    expect(sessions.mcpConnections.map((c) => c.label)).toContain(CLIENT_NAME);

    const me = (await (await owner.as('/api/auth/me')).json()) as { connectedApps: string[] };
    expect(me.connectedApps).toContain(CLIENT_NAME);
  });

  it('revoking the connection kills access and refresh together', async () => {
    const { clientId, accessToken, refreshToken } = await connectFully(server, owner);
    expect((await mcpCall(server, accessToken, toolsList)).status).toBe(200);

    const connectionId = connectionByLabel()?.id;
    const revoked = await owner.as(`/api/auth/mcp-connections/${connectionId}`, { method: 'DELETE' });
    expect(revoked.status).toBe(204);

    // Access is gone at once.
    expect((await mcpCall(server, accessToken, toolsList)).status).toBe(401);
    // And the refresh token cannot mint a fresh one.
    const afterRevoke = await refresh(server, { refreshToken, clientId });
    expect(afterRevoke.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------

describe('the full walk a browser connector makes', () => {
  it('registers, consents, exchanges, publishes, refreshes, and publishes again', async () => {
    // Register.
    const { clientId } = await registerOk(server);
    const { verifier, challenge } = pkcePair();

    // Consent (as the signed-in person) and get a code.
    const consented = await consent(server, owner, {
      clientId,
      challenge,
      resource: mcpResource(server),
      state: 's-1',
    });
    expect(consented.code).toBeTruthy();

    // Exchange the code for tokens.
    const exchanged = await exchangeCode(server, { code: consented.code!, verifier, clientId });
    expect(exchanged.status).toBe(200);
    const accessToken = exchanged.json.access_token as string;

    // Publish over /mcp with the access token.
    const publish = await mcpCall(server, accessToken, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'publish_artifact',
        arguments: { content: '# From a browser\n\nNo terminal here.', format: 'markdown' },
      },
    });
    expect(publish.status).toBe(200);
    const publishBody = (await publish.json()) as {
      result: { content: { text: string }[]; isError?: boolean };
    };
    expect(publishBody.result.isError).toBeUndefined();
    expect(publishBody.result.content[0]?.text).toContain('Published');

    // Refresh, then publish again with the new access token.
    const rotated = await refresh(server, {
      refreshToken: exchanged.json.refresh_token as string,
      clientId,
    });
    expect(rotated.status).toBe(200);

    const second = await mcpCall(server, rotated.json.access_token as string, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'publish_artifact',
        arguments: { content: '# A second page', format: 'markdown' },
      },
    });
    const secondBody = (await second.json()) as { result: { isError?: boolean } };
    expect(secondBody.result.isError).toBeUndefined();

    // Both pages belong to the same one connection.
    const list = await mcpCall(server, rotated.json.access_token as string, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'list_artifacts', arguments: {} },
    });
    const listText = ((await list.json()) as { result: { content: { text: string }[] } }).result
      .content[0]?.text;
    expect(listText).toContain('From a browser');
    expect(listText).toContain('A second page');
  });
});
