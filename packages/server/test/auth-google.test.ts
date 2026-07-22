import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestServer, signIn, type TestServer } from './helpers/server.js';

let server: TestServer;

const GOOGLE_ENV = {
  GOOGLE_CLIENT_ID: 'client-id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'client-secret',
  SIGNUP_MODE: 'open',
};

beforeEach(() => {
  server = createTestServer(GOOGLE_ENV);
});

afterEach(() => {
  server.close();
});

/** Runs the callback the way Google's redirect would, carrying the matching state. */
async function completeCallback(options: {
  state: string;
  cookieState?: string;
  code?: string;
}): Promise<Response> {
  const query = new URLSearchParams({ state: options.state });
  if (options.code !== undefined) query.set('code', options.code);

  return server.request(`/auth/google/callback?${query.toString()}`, {
    redirect: 'manual',
    headers: { Cookie: `oa_google_state=${options.cookieState ?? options.state}` },
  });
}

/** Starts a sign-in and returns the state Google would hand back. */
async function startSignIn(redirectTo?: string): Promise<{ state: string; location: URL }> {
  const path = redirectTo
    ? `/auth/google/start?redirectTo=${encodeURIComponent(redirectTo)}`
    : '/auth/google/start';
  const response = await server.request(path, { redirect: 'manual' });

  const location = new URL(response.headers.get('location') ?? '');
  return { state: location.searchParams.get('state') ?? '', location };
}

describe('starting a Google sign-in', () => {
  it('sends the browser to Google with what Google needs', async () => {
    const { location } = await startSignIn();

    expect(location.origin + location.pathname).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth',
    );
    expect(location.searchParams.get('client_id')).toBe(GOOGLE_ENV.GOOGLE_CLIENT_ID);
    expect(location.searchParams.get('response_type')).toBe('code');
    expect(location.searchParams.get('scope')).toContain('email');
    expect(location.searchParams.get('redirect_uri')).toBe(
      'https://artifacts.test/auth/google/callback',
    );
  });

  it('asks Google which account to use rather than reusing the last one', async () => {
    // On a shared computer, silently reusing the previous grant would sign
    // someone in as whoever used it last.
    const { location } = await startSignIn();
    expect(location.searchParams.get('prompt')).toBe('select_account');
  });

  it('carries state, and puts the same state in a short-lived cookie', async () => {
    const response = await server.request('/auth/google/start', { redirect: 'manual' });
    const location = new URL(response.headers.get('location') ?? '');
    const cookie = response.headers.get('set-cookie') ?? '';

    expect(location.searchParams.get('state')).toBeTruthy();
    expect(cookie).toContain('oa_google_state=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Max-Age=600');
  });
});

describe('coming back from Google', () => {
  it('signs in a new person and creates their account', async () => {
    const { state } = await startSignIn();
    server.google.nextIdentity = {
      email: 'newcomer@example.com',
      emailVerified: true,
      displayName: 'New Comer',
    };

    const response = await completeCallback({ state, code: 'google-code' });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/');
    expect(response.headers.get('set-cookie')).toContain('oa_session=');

    const row = server.database.raw
      .prepare('select display_name, email_verified from users where email = ?')
      .get('newcomer@example.com') as { display_name: string; email_verified: number };
    expect(row.display_name).toBe('New Comer');
    expect(row.email_verified).toBe(1);
  });

  it('lands on the same account as an email link with the same address', async () => {
    // This is the point of using the address as the identity: two doors, one room.
    await signIn(server, 'person@example.com');

    const { state } = await startSignIn();
    server.google.nextIdentity = {
      email: 'person@example.com',
      emailVerified: true,
      displayName: 'The Person',
    };
    await completeCallback({ state, code: 'google-code' });

    const count = server.database.raw
      .prepare('select count(*) as count from users where email = ?')
      .get('person@example.com') as { count: number };
    expect(count.count).toBe(1);
  });

  it('fills in a display name learned from Google without overwriting one already set', async () => {
    await signIn(server, 'person@example.com');
    server.database.raw
      .prepare('update users set display_name = ? where email = ?')
      .run('Chosen Name', 'person@example.com');

    const { state } = await startSignIn();
    server.google.nextIdentity = {
      email: 'person@example.com',
      emailVerified: true,
      displayName: 'Google Name',
    };
    await completeCallback({ state, code: 'google-code' });

    const row = server.database.raw
      .prepare('select display_name from users where email = ?')
      .get('person@example.com') as { display_name: string };
    expect(row.display_name).toBe('Chosen Name');
  });

  it('matches the address whatever case Google sends it in', async () => {
    await signIn(server, 'person@example.com');

    const { state } = await startSignIn();
    server.google.nextIdentity = {
      email: 'Person@Example.COM',
      emailVerified: true,
      displayName: null,
    };
    await completeCallback({ state, code: 'google-code' });

    const count = server.database.raw.prepare('select count(*) as count from users').get() as {
      count: number;
    };
    expect(count.count).toBe(1);
  });

  it('refuses an address Google has not verified', async () => {
    // Otherwise someone could claim an address they do not own, and with it
    // anything already shared with that address.
    const { state } = await startSignIn();
    server.google.nextIdentity = {
      email: 'unverified@example.com',
      emailVerified: false,
      displayName: null,
    };

    const response = await completeCallback({ state, code: 'google-code' });
    expect(response.status).toBe(401);

    const count = server.database.raw
      .prepare('select count(*) as count from users where email = ?')
      .get('unverified@example.com') as { count: number };
    expect(count.count).toBe(0);
  });

  it('sends the person on to where they were headed', async () => {
    const { state } = await startSignIn('/a/some-slug');
    server.google.nextIdentity = {
      email: 'reader@example.com',
      emailVerified: true,
      displayName: null,
    };

    const response = await completeCallback({ state, code: 'google-code' });
    expect(response.headers.get('location')).toBe('/a/some-slug');
  });

  it('refuses to redirect anywhere but this instance', async () => {
    const { state } = await startSignIn('https://evil.example.com');
    server.google.nextIdentity = {
      email: 'reader@example.com',
      emailVerified: true,
      displayName: null,
    };

    const response = await completeCallback({ state, code: 'google-code' });
    expect(response.headers.get('location')).toBe('/');
  });
});

describe('a callback that did not come from a sign-in this browser started', () => {
  it('is refused when the state does not match the cookie', async () => {
    // This is the attack: feed someone a callback URL carrying the attacker's own
    // authorisation code, and they end up quietly signed into the attacker's
    // account, where anything they publish is readable by the attacker.
    const { state } = await startSignIn();
    server.google.nextIdentity = {
      email: 'attacker@example.com',
      emailVerified: true,
      displayName: null,
    };

    const response = await completeCallback({
      state,
      cookieState: 'a-different-sign-in',
      code: 'attacker-code',
    });

    expect(response.status).toBe(401);
    expect(server.google.exchanged).toHaveLength(0);
  });

  it('is refused when there is no state cookie at all', async () => {
    const { state } = await startSignIn();
    const response = await server.request(`/auth/google/callback?state=${state}&code=x`, {
      redirect: 'manual',
    });
    expect(response.status).toBe(401);
  });

  it('is refused when the state was not signed by this server', async () => {
    const forged = 'eyJub25jZSI6IngifQ.forged-signature';
    const response = await completeCallback({ state: forged, code: 'x' });
    expect(response.status).toBe(401);
  });

  it('is refused when the state carries no signature', async () => {
    const response = await completeCallback({ state: 'no-signature-here', code: 'x' });
    expect(response.status).toBe(401);
  });
});

describe('when someone changes their mind', () => {
  it('takes a cancelled sign-in back to the start without an error page', async () => {
    const response = await server.request('/auth/google/callback?error=access_denied', {
      redirect: 'manual',
    });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('cancelled');
  });
});

describe('an instance with no Google credentials', () => {
  it('says so plainly instead of failing in a way that looks broken', async () => {
    const plain = createTestServer({ SIGNUP_MODE: 'open' });
    try {
      const response = await plain.request('/auth/google/start', { redirect: 'manual' });
      expect(response.status).toBe(404);

      const body = (await response.json()) as { error: { message: string } };
      expect(body.error.message).toContain('sign-in code');
    } finally {
      plain.close();
    }
  });

  it('still lets everybody sign in by email link, so no demo ever blocks on Google', async () => {
    const plain = createTestServer({ SIGNUP_MODE: 'open' });
    try {
      const person = await signIn(plain, 'reader@example.com');
      expect((await person.as('/api/auth/me')).status).toBe(200);
    } finally {
      plain.close();
    }
  });
});
