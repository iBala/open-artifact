import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestServer, signIn, jsonBody, type TestServer, type SignedInUser } from './helpers/server.js';

/**
 * Everywhere an account is signed in, and taking that access away.
 *
 * This is the only recourse somebody has when a laptop goes missing or an agent
 * was set up on a machine it should not have been, so revocation has to take
 * effect on the very next request, not at the next expiry.
 */

let server: TestServer;
let person: SignedInUser;

beforeEach(async () => {
  server = createTestServer({ SIGNUP_MODE: 'open' });
  person = await signIn(server, 'person@example.com');
});

afterEach(() => {
  server.close();
});

interface SessionList {
  sessions: {
    id: string;
    label: string | null;
    createdAt: string;
    lastSeenAt: string;
    expiresAt: string;
    isCurrent: boolean;
  }[];
  tokens: { id: string; label: string | null; lastUsedAt: string | null; expiresAt: string }[];
}

async function list(as: SignedInUser = person): Promise<SessionList> {
  const response = await as.as('/api/auth/sessions');
  expect(response.status).toBe(200);
  return (await response.json()) as SessionList;
}

/** Signs a command line in, the way the device flow does. */
async function addCliToken(label = 'Claude Code'): Promise<string> {
  const started = (await (
    await server.request('/api/auth/device', jsonBody({ label }))
  ).json()) as { deviceCode: string; userCode: string };

  await person.as('/api/auth/device/approve', jsonBody({ userCode: started.userCode }));

  const claimed = (await (
    await server.request('/api/auth/device/token', jsonBody({ deviceCode: started.deviceCode }))
  ).json()) as { token: string };

  return claimed.token;
}

describe('seeing where an account is signed in', () => {
  it('lists this browser, and says which one it is', async () => {
    const listed = await list();

    expect(listed.sessions).toHaveLength(1);
    expect(listed.sessions[0]?.isCurrent).toBe(true);
  });

  it('lists every browser separately', async () => {
    await signIn(server, 'person@example.com');
    expect((await list()).sessions).toHaveLength(2);

    // Only one of them is the browser doing the asking.
    expect((await list()).sessions.filter((session) => session.isCurrent)).toHaveLength(1);
  });

  it('lists command lines separately from browsers, with their labels', async () => {
    await addCliToken('Claude Code on the laptop');

    const listed = await list();
    expect(listed.tokens).toHaveLength(1);
    expect(listed.tokens[0]?.label).toBe('Claude Code on the laptop');
  });

  it('shows when a command line was last used, so a forgotten one stands out', async () => {
    const token = await addCliToken();
    expect((await list()).tokens[0]?.lastUsedAt).toBeNull();

    await server.request('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } });

    expect((await list()).tokens[0]?.lastUsedAt).toMatch(/^\d{4}-/);
  });

  it('never shows one person another person’s sessions', async () => {
    const other = await signIn(server, 'other@example.com');
    await addCliToken();

    const theirs = await list(other);
    expect(theirs.sessions).toHaveLength(1);
    expect(theirs.tokens).toHaveLength(0);
  });

  it('needs somebody signed in', async () => {
    expect((await server.request('/api/auth/sessions')).status).toBe(401);
  });
});

describe('taking access away', () => {
  it('signs another browser out, and that browser stops working at once', async () => {
    const otherBrowser = await signIn(server, 'person@example.com');
    const theirSession = (await list(otherBrowser)).sessions.find((s) => s.isCurrent);

    const revoked = await person.as(`/api/auth/sessions/${theirSession?.id}`, {
      method: 'DELETE',
    });
    expect(revoked.status).toBe(204);

    expect((await otherBrowser.as('/api/auth/me')).status).toBe(401);
    // And the browser that did the revoking is untouched.
    expect((await person.as('/api/auth/me')).status).toBe(200);
  });

  it('takes a command line’s access away immediately', async () => {
    const token = await addCliToken();
    const tokenId = (await list()).tokens[0]?.id;

    expect(
      (await server.request('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } }))
        .status,
    ).toBe(200);

    await person.as(`/api/auth/tokens/${tokenId}`, { method: 'DELETE' });

    expect(
      (await server.request('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } }))
        .status,
    ).toBe(401);
  });

  it('drops a revoked session out of the list', async () => {
    const otherBrowser = await signIn(server, 'person@example.com');
    const theirSession = (await list(otherBrowser)).sessions.find((s) => s.isCurrent);

    await person.as(`/api/auth/sessions/${theirSession?.id}`, { method: 'DELETE' });

    expect((await list()).sessions).toHaveLength(1);
  });

  it('refuses to let one person revoke another person’s session', async () => {
    const other = await signIn(server, 'other@example.com');
    const theirSession = (await list(other)).sessions[0];

    const response = await person.as(`/api/auth/sessions/${theirSession?.id}`, {
      method: 'DELETE',
    });
    expect(response.status).toBe(404);

    // And they are still signed in.
    expect((await other.as('/api/auth/me')).status).toBe(200);
  });

  it('refuses to let one person revoke another person’s command line', async () => {
    const other = await signIn(server, 'other@example.com');
    const token = await addCliToken();
    const tokenId = (await list()).tokens[0]?.id;

    expect((await other.as(`/api/auth/tokens/${tokenId}`, { method: 'DELETE' })).status).toBe(404);

    expect(
      (await server.request('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } }))
        .status,
    ).toBe(200);
  });

  it('says not found for a session id that never existed', async () => {
    expect((await person.as('/api/auth/sessions/ses_nope', { method: 'DELETE' })).status).toBe(404);
  });
});

describe('what a revoked credential can still do', () => {
  it('nothing: a revoked token cannot read or publish', async () => {
    const token = await addCliToken();
    const tokenId = (await list()).tokens[0]?.id;
    await person.as(`/api/auth/tokens/${tokenId}`, { method: 'DELETE' });

    const published = await server.request('/api/artifacts', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'markdown', content: '# After revocation' }),
    });
    expect(published.status).toBe(401);
  });
});
