import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTestServer,
  jsonBody,
  signIn,
  magicLinkFor,
  sessionCookieFrom,
  type TestServer,
} from './helpers/server.js';

let server: TestServer;

beforeEach(() => {
  // Open signup keeps these tests about the sign-in flow itself; the signup rules
  // have their own tests.
  server = createTestServer({ SIGNUP_MODE: 'open' });
});

afterEach(() => {
  server.close();
});

const requestLink = (email: unknown, extra: Record<string, unknown> = {}) =>
  server.request('/api/auth/magic-link', jsonBody({ email, ...extra }));

const follow = (link: URL) =>
  server.request(link.pathname + link.search, { redirect: 'manual' });

describe('asking for a sign-in link', () => {
  it('sends an email with a working link', async () => {
    const response = await requestLink('reader@example.com');
    expect(response.status).toBe(200);

    const email = server.mailer.lastTo('reader@example.com');
    expect(email?.subject).toContain('artifacts.test');
    expect(email?.text).toContain('/auth/verify?token=');
    // Some people read mail as plain text; the link has to work there too.
    expect(email?.text).toMatch(/https:\/\/artifacts\.test\/auth\/verify\?token=\S+/);
  });

  it('says the same thing whether or not the address has an account', async () => {
    await signIn(server, 'existing@example.com');
    server.mailer.clear();

    const known = await requestLink('existing@example.com');
    const unknown = await requestLink('stranger@example.com');

    expect(known.status).toBe(unknown.status);
    expect(await known.json()).toEqual(await unknown.json());
  });

  it('treats the address as case-insensitive', async () => {
    await requestLink('Reader@Example.COM');
    expect(server.mailer.lastTo('reader@example.com')).toBeTruthy();
  });

  it('refuses something that is not an email address', async () => {
    const response = await requestLink('not-an-address');
    expect(response.status).toBe(400);
    expect(server.mailer.sent).toHaveLength(0);
  });
});

describe('following a sign-in link', () => {
  it('signs the person in and sets a session cookie', async () => {
    await requestLink('reader@example.com');
    const response = await follow(magicLinkFor(server, 'reader@example.com'));

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/');

    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('oa_session=');
    // Script must never be able to read the session.
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('Path=/');
  });

  it('creates the account on first sign-in and reuses it after', async () => {
    await requestLink('reader@example.com');
    await follow(magicLinkFor(server, 'reader@example.com'));
    server.mailer.clear();

    await requestLink('reader@example.com');
    await follow(magicLinkFor(server, 'reader@example.com'));

    const count = server.database.raw.prepare('select count(*) as count from users').get() as {
      count: number;
    };
    expect(count.count).toBe(1);
  });

  it('marks the address as verified, because following the link is the proof', async () => {
    await requestLink('reader@example.com');
    await follow(magicLinkFor(server, 'reader@example.com'));

    const row = server.database.raw
      .prepare('select email_verified from users where email = ?')
      .get('reader@example.com') as { email_verified: number };
    expect(row.email_verified).toBe(1);
  });

  it('works once, then never again', async () => {
    await requestLink('reader@example.com');
    const link = magicLinkFor(server, 'reader@example.com');

    expect((await follow(link)).status).toBe(302);

    const second = await follow(link);
    expect(second.status).toBe(401);
    // The message must not distinguish "already used" from "never existed".
    expect(await messageOf(second)).toContain('no longer valid');
  });

  it('refuses a link that has expired', async () => {
    await requestLink('reader@example.com');
    const link = magicLinkFor(server, 'reader@example.com');

    // Move the link's expiry into the past, the way fifteen minutes passing would.
    server.database.raw
      .prepare("update magic_links set expires_at = '2020-01-01T00:00:00.000Z'")
      .run();

    const response = await follow(link);
    expect(response.status).toBe(401);
    expect(await messageOf(response)).toContain('no longer valid');
  });

  it('refuses a made-up token with the same message as a used one', async () => {
    const response = await server.request('/auth/verify?token=completely-made-up', {
      redirect: 'manual',
    });
    expect(response.status).toBe(401);
    expect(await messageOf(response)).toContain('no longer valid');
  });

  it('refuses a link with no token at all', async () => {
    expect((await server.request('/auth/verify')).status).toBe(400);
  });

  it('sends the person on to where they were headed', async () => {
    await requestLink('reader@example.com', { redirectTo: '/a/some-artifact-slug' });
    const response = await follow(magicLinkFor(server, 'reader@example.com'));
    expect(response.headers.get('location')).toBe('/a/some-artifact-slug');
  });

  it('refuses to be turned into a redirect to another site', async () => {
    // Otherwise a link could sign someone in and then hand them to a page
    // someone else controls, with our domain still in the address bar.
    for (const hostile of [
      'https://evil.example.com',
      '//evil.example.com',
      'javascript:alert(1)',
    ]) {
      server.mailer.clear();
      await requestLink('reader@example.com', { redirectTo: hostile });
      const response = await follow(magicLinkFor(server, 'reader@example.com'));
      expect(response.headers.get('location')).toBe('/');
    }
  });
});

describe('being signed in', () => {
  it('answers who I am', async () => {
    const person = await signIn(server, 'reader@example.com');
    const response = await person.as('/api/auth/me');

    expect(response.status).toBe(200);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      email: 'reader@example.com',
    });
  });

  it('refuses to say who I am when I am nobody', async () => {
    expect((await server.request('/api/auth/me')).status).toBe(401);
  });

  it('signing out kills the session immediately', async () => {
    const person = await signIn(server, 'reader@example.com');
    expect((await person.as('/api/auth/me')).status).toBe(200);

    await person.as('/api/auth/sign-out', { method: 'POST' });

    // The same cookie no longer works, even though the browser still has it.
    expect((await person.as('/api/auth/me')).status).toBe(401);
  });

  it('gives each sign-in its own session, so signing out of one keeps the other', async () => {
    const laptop = await signIn(server, 'reader@example.com');
    const phone = await signIn(server, 'reader@example.com');

    await laptop.as('/api/auth/sign-out', { method: 'POST' });

    expect((await laptop.as('/api/auth/me')).status).toBe(401);
    expect((await phone.as('/api/auth/me')).status).toBe(200);
  });

  it('labels the session with the device it came from', async () => {
    await requestLink('reader@example.com');
    const response = await server.request(
      magicLinkFor(server, 'reader@example.com').pathname +
        magicLinkFor(server, 'reader@example.com').search,
      {
        redirect: 'manual',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        },
      },
    );
    sessionCookieFrom(response);

    const row = server.database.raw.prepare('select label from auth_sessions').get() as {
      label: string;
    };
    expect(row.label).toBe('Chrome on macOS');
  });
});

describe('which sign-in methods this instance offers', () => {
  it('offers email links always, and Google only when it is configured', async () => {
    const response = await server.request('/api/auth/methods');
    expect(await response.json()).toMatchObject({ magicLink: true, google: false });
  });

  it('offers Google once credentials are set', async () => {
    const withGoogle = createTestServer({
      GOOGLE_CLIENT_ID: 'id.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'secret',
    });
    try {
      const response = await withGoogle.request('/api/auth/methods');
      expect(await response.json()).toMatchObject({ google: true });
    } finally {
      withGoogle.close();
    }
  });
});

async function messageOf(response: Response): Promise<string> {
  return ((await response.json()) as { error: { message: string } }).error.message;
}
