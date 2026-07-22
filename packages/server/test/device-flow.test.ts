import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestServer, signIn, jsonBody, type TestServer, type SignedInUser } from './helpers/server.js';

let server: TestServer;
let person: SignedInUser;

beforeEach(async () => {
  server = createTestServer({ SIGNUP_MODE: 'open' });
  person = await signIn(server, 'person@example.com');
});

afterEach(() => {
  server.close();
});

interface StartedLogin {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresInSeconds: number;
  intervalSeconds: number;
}

async function startLogin(label?: string): Promise<StartedLogin> {
  const response = await server.request('/api/auth/device', jsonBody(label ? { label } : {}));
  expect(response.status).toBe(200);
  return (await response.json()) as StartedLogin;
}

const poll = (deviceCode: string) =>
  server.request('/api/auth/device/token', jsonBody({ deviceCode }));

const approve = (userCode: string, approve = true) =>
  person.as('/api/auth/device/approve', jsonBody({ userCode, approve }));

describe('starting a sign-in from the command line', () => {
  it('hands back a short code to read out and a long one to keep', async () => {
    const started = await startLogin();

    // Short enough to read across a desk, with no characters that get misread.
    expect(started.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(started.userCode).not.toMatch(/[OIL01U]/);

    // The one the CLI keeps is long and never shown to anyone.
    expect(started.deviceCode.length).toBeGreaterThan(30);
    expect(started.deviceCode).not.toContain(started.userCode);
  });

  it('tells the CLI where to send the person and how often to check back', async () => {
    const started = await startLogin();
    expect(started.verificationUrl).toContain('/auth/device?code=');
    expect(started.verificationUrl).toContain(started.userCode);
    expect(started.intervalSeconds).toBeGreaterThan(0);
    expect(started.expiresInSeconds).toBe(600);
  });

  it('gives two terminals different codes', async () => {
    const first = await startLogin();
    const second = await startLogin();
    expect(first.userCode).not.toBe(second.userCode);
    expect(first.deviceCode).not.toBe(second.deviceCode);
  });

  it('needs nobody signed in, because the terminal is not signed in yet', async () => {
    // The whole point: the CLI has no credentials at this moment.
    expect((await server.request('/api/auth/device', jsonBody({}))).status).toBe(200);
  });
});

describe('waiting for approval', () => {
  it('says pending, and hands out nothing, until somebody approves', async () => {
    const started = await startLogin();

    const response = await poll(started.deviceCode);
    expect(response.status).toBe(202);
    expect((await response.json()) as { state: string }).toEqual({ state: 'pending' });
  });

  it('hands the CLI a token once approved', async () => {
    const started = await startLogin();
    expect((await approve(started.userCode)).status).toBe(200);

    const response = await poll(started.deviceCode);
    expect(response.status).toBe(200);

    const body = (await response.json()) as { state: string; token: string; expiresAt: string };
    expect(body.state).toBe('approved');
    expect(body.token.length).toBeGreaterThan(30);
    expect(body.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  it('gives a token that actually works as that person', async () => {
    const started = await startLogin();
    await approve(started.userCode);
    const { token } = (await (await poll(started.deviceCode)).json()) as { token: string };

    const response = await server.request('/api/auth/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(((await response.json()) as { email: string }).email).toBe('person@example.com');
  });

  it('lasts about ninety days, so a working agent never gets logged out', async () => {
    const started = await startLogin();
    await approve(started.userCode);
    const { expiresAt } = (await (await poll(started.deviceCode)).json()) as { expiresAt: string };

    const days = (new Date(expiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(89);
    expect(days).toBeLessThan(91);
  });

  it('hands out a token exactly once', async () => {
    const started = await startLogin();
    await approve(started.userCode);
    expect((await poll(started.deviceCode)).status).toBe(200);

    // A second poll for the same code is either a bug or a replay. Neither
    // should produce a second working token.
    expect((await poll(started.deviceCode)).status).toBe(401);
  });

  it('reports a refusal so the CLI can say so instead of hanging', async () => {
    const started = await startLogin();
    await approve(started.userCode, false);

    const response = await poll(started.deviceCode);
    expect(response.status).toBe(403);
    expect((await response.json()) as { state: string }).toEqual({ state: 'denied' });
  });

  it('reports expiry rather than waiting forever', async () => {
    const started = await startLogin();
    server.database.raw
      .prepare("update device_codes set expires_at = '2020-01-01T00:00:00.000Z'")
      .run();

    const response = await poll(started.deviceCode);
    expect(response.status).toBe(410);
    expect((await response.json()) as { state: string }).toEqual({ state: 'expired' });
  });

  it('refuses a device code this server never issued', async () => {
    expect((await poll('a-code-from-nowhere')).status).toBe(401);
  });
});

describe('approving in the browser', () => {
  it('sends someone who is not signed in to sign in, and back again', async () => {
    const started = await startLogin();
    const response = await server.request(`/auth/device?code=${started.userCode}`, {
      redirect: 'manual',
    });

    expect(response.status).toBe(302);
    const location = response.headers.get('location') ?? '';
    expect(location).toContain('/login');
    // The code has to survive the round trip, or the person has to type it again.
    expect(decodeURIComponent(location)).toContain(`/auth/device?code=${started.userCode}`);
  });

  it('shows the code and asks the person to check it matches their terminal', async () => {
    const started = await startLogin('Claude Code');
    const page = await (await person.as(`/auth/device?code=${started.userCode}`)).text();

    expect(page).toContain(started.userCode);
    expect(page).toContain('Claude Code');
    expect(page).toContain('person@example.com');
    // This sentence is what stops somebody reading out their own code down the
    // phone for a victim to approve.
    expect(page).toContain('matches the one in your terminal');
  });

  it('says plainly when a code means nothing', async () => {
    const page = await (await person.as('/auth/device?code=ZZZZ-9999')).text();
    expect(page).toContain('does not match anything');
  });

  it('says plainly when a code has expired', async () => {
    const started = await startLogin();
    server.database.raw
      .prepare("update device_codes set expires_at = '2020-01-01T00:00:00.000Z'")
      .run();

    const page = await (await person.as(`/auth/device?code=${started.userCode}`)).text();
    expect(page).toContain('expired');
  });

  it('refuses to approve a code twice', async () => {
    const started = await startLogin();
    expect((await approve(started.userCode)).status).toBe(200);
    expect((await approve(started.userCode)).status).toBe(400);
  });

  it('needs somebody signed in to approve anything', async () => {
    const started = await startLogin();
    const response = await server.request(
      '/api/auth/device/approve',
      jsonBody({ userCode: started.userCode }),
    );
    expect(response.status).toBe(401);
  });

  it('accepts the code however the person typed it', async () => {
    const started = await startLogin();
    const typed = started.userCode.toLowerCase().replace('-', '');

    expect((await approve(typed)).status).toBe(200);
  });

  it('grants access to the person who approved, not to whoever asked', async () => {
    const started = await startLogin();
    const someoneElse = await signIn(server, 'someone-else@example.com');

    await someoneElse.as('/api/auth/device/approve', jsonBody({ userCode: started.userCode }));
    const { token } = (await (await poll(started.deviceCode)).json()) as { token: string };

    const response = await server.request('/api/auth/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(((await response.json()) as { email: string }).email).toBe('someone-else@example.com');
  });
});

describe('what the short code is worth on its own', () => {
  it('is nothing: approving it hands the token only to whoever holds the long one', async () => {
    const started = await startLogin();
    await approve(started.userCode);

    // Somebody who saw the short code over a shoulder still has no way to
    // collect the token, because polling needs the device code.
    const response = await server.request(
      '/api/auth/device/token',
      jsonBody({ deviceCode: started.userCode }),
    );
    expect(response.status).toBe(401);

    // And the real CLI still gets its token.
    expect((await poll(started.deviceCode)).status).toBe(200);
  });
});
