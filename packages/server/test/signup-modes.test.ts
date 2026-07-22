import { describe, it, expect, afterEach } from 'vitest';
import { createTestServer, jsonBody, magicLinkFor, type TestServer } from './helpers/server.js';

/**
 * Who is allowed to create an account here.
 *
 * The refusal happens when a link is followed, not when it is requested, so that
 * asking for a link never reveals whether an address would be allowed in.
 */

const servers: TestServer[] = [];

afterEach(() => {
  while (servers.length > 0) servers.pop()?.close();
});

function serverWith(env: Record<string, string | undefined>): TestServer {
  const server = createTestServer(env);
  servers.push(server);
  return server;
}

/** Runs the whole sign-in flow and reports how it ended. */
async function attemptSignIn(
  server: TestServer,
  email: string,
): Promise<{ status: number; message: string }> {
  await server.request('/api/auth/magic-link', jsonBody({ email }));
  const link = magicLinkFor(server, email);
  const response = await server.request(link.pathname + link.search, { redirect: 'manual' });

  if (response.status === 302) return { status: 302, message: '' };
  const body = (await response.json()) as { error: { message: string } };
  return { status: response.status, message: body.error.message };
}

/**
 * Every mode has to let the first person in, or a fresh install can never be
 * used: there is nobody there to send the first invitation.
 */
async function claimFirstAccount(server: TestServer): Promise<void> {
  const result = await attemptSignIn(server, 'founder@example.com');
  expect(result.status).toBe(302);
  server.mailer.clear();
}

describe('open signup', () => {
  it('lets anybody in', async () => {
    const server = serverWith({ SIGNUP_MODE: 'open' });
    await claimFirstAccount(server);
    expect((await attemptSignIn(server, 'anyone@wherever.example')).status).toBe(302);
  });
});

describe('invite-only signup, the default', () => {
  it('is what a fresh instance uses unless told otherwise', () => {
    expect(serverWith({}).config.signupMode).toBe('invite-only');
  });

  it('still lets the very first person in, so the instance is usable', async () => {
    const server = serverWith({ SIGNUP_MODE: 'invite-only' });
    expect((await attemptSignIn(server, 'founder@example.com')).status).toBe(302);
  });

  it('turns away everyone after that, until sharing invites them', async () => {
    const server = serverWith({ SIGNUP_MODE: 'invite-only' });
    await claimFirstAccount(server);

    const result = await attemptSignIn(server, 'stranger@example.com');
    expect(result.status).toBe(403);
    expect(result.message).toContain('invite only');
  });

  it('lets someone who already has an account keep signing in', async () => {
    const server = serverWith({ SIGNUP_MODE: 'invite-only' });
    await claimFirstAccount(server);
    // The rule is about creating accounts, not about using one you have.
    expect((await attemptSignIn(server, 'founder@example.com')).status).toBe(302);
  });
});

describe('domain-allowlist signup', () => {
  const env = { SIGNUP_MODE: 'domain-allowlist', SIGNUP_ALLOWED_DOMAINS: 'example.com,zorp.one' };

  it('lets in an address on an allowed domain', async () => {
    const server = serverWith(env);
    await claimFirstAccount(server);
    expect((await attemptSignIn(server, 'colleague@zorp.one')).status).toBe(302);
  });

  it('turns away an address on any other domain, and says why', async () => {
    const server = serverWith(env);
    await claimFirstAccount(server);

    const result = await attemptSignIn(server, 'outsider@gmail.com');
    expect(result.status).toBe(403);
    expect(result.message).toContain('email domains');
  });

  it('matches the domain whatever case it is written in', async () => {
    const server = serverWith(env);
    await claimFirstAccount(server);
    expect((await attemptSignIn(server, 'Colleague@ZORP.ONE')).status).toBe(302);
  });

  it('does not treat a domain as allowed just because it ends the same way', async () => {
    const server = serverWith(env);
    await claimFirstAccount(server);
    // notexample.com must not pass because it ends in example.com.
    expect((await attemptSignIn(server, 'attacker@notexample.com')).status).toBe(403);
    expect((await attemptSignIn(server, 'attacker@example.com.evil.test')).status).toBe(403);
  });
});

describe('what the refusal does not give away', () => {
  it('sends a link to an address that will be turned away, so asking reveals nothing', async () => {
    const server = serverWith({ SIGNUP_MODE: 'invite-only' });
    await claimFirstAccount(server);

    const response = await server.request(
      '/api/auth/magic-link',
      jsonBody({ email: 'stranger@example.com' }),
    );

    expect(response.status).toBe(200);
    expect(server.mailer.lastTo('stranger@example.com')).toBeTruthy();
  });

  it('creates no account for someone who is turned away', async () => {
    const server = serverWith({ SIGNUP_MODE: 'invite-only' });
    await claimFirstAccount(server);
    await attemptSignIn(server, 'stranger@example.com');

    const row = server.database.raw
      .prepare('select count(*) as count from users where email = ?')
      .get('stranger@example.com') as { count: number };
    expect(row.count).toBe(0);
  });
});
