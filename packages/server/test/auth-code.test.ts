import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTestServer,
  jsonBody,
  signIn,
  signInCodeFor,
  sessionCookieFrom,
  type TestServer,
} from './helpers/server.js';
import { MAX_SIGN_IN_CODE_ATTEMPTS } from '../src/auth/service.js';

let server: TestServer;

beforeEach(() => {
  // Open signup keeps these tests about the sign-in flow itself; the signup rules
  // have their own tests.
  server = createTestServer({ SIGNUP_MODE: 'open' });
});

afterEach(() => {
  server.close();
});

const requestCode = (email: unknown, extra: Record<string, unknown> = {}) =>
  server.request('/api/auth/code', jsonBody({ email, ...extra }));

const enterCode = (email: string, code: string, init: RequestInit = {}) =>
  server.request('/api/auth/verify-code', {
    ...jsonBody({ email, code }),
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });

/** Any six digits that are not the ones sitting in the inbox. */
function aDifferentCode(real: string): string {
  return String((Number(real) + 1) % 1_000_000).padStart(6, '0');
}

describe('asking for a sign-in code', () => {
  it('sends an email with six digits in it', async () => {
    const response = await requestCode('reader@example.com');
    expect(response.status).toBe(200);

    const email = server.mailer.lastTo('reader@example.com');
    expect(email?.subject).toContain('artifacts.test');
    // The code is the point of the email, so it leads the subject line too.
    expect(email?.subject).toMatch(/^\d{3} \d{3} /);
    // Some people read mail as plain text; the code has to be there too.
    expect(email?.text).toMatch(/\d{3} \d{3}/);
    expect(signInCodeFor(server, 'reader@example.com')).toMatch(/^\d{6}$/);
  });

  it('sends nothing to click, which is the whole point of the change', async () => {
    await requestCode('reader@example.com');
    const email = server.mailer.lastTo('reader@example.com');

    expect(email?.text).not.toContain('/auth/verify');
    expect(email?.html).not.toContain('<a ');
  });

  it('says the same thing whether or not the address has an account', async () => {
    await signIn(server, 'existing@example.com');
    server.mailer.clear();

    const known = await requestCode('existing@example.com');
    const unknown = await requestCode('stranger@example.com');

    expect(known.status).toBe(unknown.status);
    expect(await known.json()).toEqual(await unknown.json());
  });

  it('treats the address as case-insensitive', async () => {
    await requestCode('Reader@Example.COM');
    expect(server.mailer.lastTo('reader@example.com')).toBeTruthy();
  });

  it('refuses something that is not an email address', async () => {
    const response = await requestCode('not-an-address');
    expect(response.status).toBe(400);
    expect(server.mailer.sent).toHaveLength(0);
  });

  it('throws away the previous code, so two are never live at once', async () => {
    await requestCode('reader@example.com');
    const first = signInCodeFor(server, 'reader@example.com');

    await requestCode('reader@example.com');
    const second = signInCodeFor(server, 'reader@example.com');

    expect((await enterCode('reader@example.com', first)).status).toBe(401);
    expect((await enterCode('reader@example.com', second)).status).toBe(200);
  });
});

describe('entering the code', () => {
  it('signs the person in and sets a session cookie', async () => {
    await requestCode('reader@example.com');
    const response = await enterCode(
      'reader@example.com',
      signInCodeFor(server, 'reader@example.com'),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ redirectTo: null });

    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('oa_session=');
    // Script must never be able to read the session.
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('Path=/');
  });

  it('accepts the code written the way the email shows it', async () => {
    await requestCode('reader@example.com');
    const code = signInCodeFor(server, 'reader@example.com');

    const response = await enterCode('reader@example.com', `${code.slice(0, 3)} ${code.slice(3)}`);
    expect(response.status).toBe(200);
  });

  it('creates the account on first sign-in and reuses it after', async () => {
    await signIn(server, 'reader@example.com');
    server.mailer.clear();
    await signIn(server, 'reader@example.com');

    const count = server.database.raw.prepare('select count(*) as count from users').get() as {
      count: number;
    };
    expect(count.count).toBe(1);
  });

  it('marks the address as verified, because typing the code back is the proof', async () => {
    await signIn(server, 'reader@example.com');

    const row = server.database.raw
      .prepare('select email_verified from users where email = ?')
      .get('reader@example.com') as { email_verified: number };
    expect(row.email_verified).toBe(1);
  });

  it('works once, then never again', async () => {
    await requestCode('reader@example.com');
    const code = signInCodeFor(server, 'reader@example.com');

    expect((await enterCode('reader@example.com', code)).status).toBe(200);

    const second = await enterCode('reader@example.com', code);
    expect(second.status).toBe(401);
    // The message must not distinguish "already used" from "never existed".
    expect(await messageOf(second)).toContain('not valid');
  });

  it('refuses a code that has expired', async () => {
    await requestCode('reader@example.com');
    const code = signInCodeFor(server, 'reader@example.com');

    // Move the expiry into the past, the way ten minutes passing would.
    server.database.raw
      .prepare("update sign_in_codes set expires_at = '2020-01-01T00:00:00.000Z'")
      .run();

    const response = await enterCode('reader@example.com', code);
    expect(response.status).toBe(401);
    expect(await messageOf(response)).toContain('not valid');
  });

  it('refuses a code that was sent to somebody else', async () => {
    await requestCode('reader@example.com');
    const theirs = signInCodeFor(server, 'reader@example.com');

    await requestCode('stranger@example.com');

    // Both addresses drawing the same six digits is a one in a million
    // coincidence; skip rather than fail on the day it happens.
    if (theirs !== signInCodeFor(server, 'stranger@example.com')) {
      expect((await enterCode('stranger@example.com', theirs)).status).toBe(401);
    }
  });

  it('refuses a wrong code, an expired one and one that never existed in the same words', async () => {
    await requestCode('reader@example.com');
    const real = signInCodeFor(server, 'reader@example.com');

    const wrong = await enterCode('reader@example.com', aDifferentCode(real));
    const neverAsked = await enterCode('nobody@example.com', '123456');

    server.database.raw
      .prepare("update sign_in_codes set expires_at = '2020-01-01T00:00:00.000Z'")
      .run();
    const expired = await enterCode('reader@example.com', real);

    expect(wrong.status).toBe(401);
    expect(neverAsked.status).toBe(401);
    expect(expired.status).toBe(401);

    const messages = [
      await messageOf(wrong),
      await messageOf(neverAsked),
      await messageOf(expired),
    ];
    expect(new Set(messages).size).toBe(1);
  });

  it('refuses something that is not six digits, without spending an attempt', async () => {
    await requestCode('reader@example.com');
    const code = signInCodeFor(server, 'reader@example.com');

    for (const nonsense of ['', '12345', '1234567', 'abcdef', 'null']) {
      expect((await enterCode('reader@example.com', nonsense)).status).toBe(401);
    }

    // A typo in the box is not a guess, so the real code still works.
    expect((await enterCode('reader@example.com', code)).status).toBe(200);
  });

  it('refuses a request with no email address at all', async () => {
    const response = await server.request('/api/auth/verify-code', jsonBody({ code: '123456' }));
    expect(response.status).toBe(400);
  });

  it('sends the person on to where they were headed', async () => {
    await requestCode('reader@example.com', { redirectTo: '/a/some-artifact-slug' });
    const response = await enterCode(
      'reader@example.com',
      signInCodeFor(server, 'reader@example.com'),
    );

    expect(await response.json()).toEqual({ redirectTo: '/a/some-artifact-slug' });
  });

  it('refuses to be turned into a redirect to another site', async () => {
    // Otherwise a shared link could sign someone in and then hand them to a page
    // someone else controls, with our domain still in the address bar.
    for (const hostile of ['https://evil.example.com', '//evil.example.com', 'javascript:alert(1)']) {
      server.mailer.clear();
      await requestCode('reader@example.com', { redirectTo: hostile });
      const response = await enterCode(
        'reader@example.com',
        signInCodeFor(server, 'reader@example.com'),
      );
      expect(await response.json()).toEqual({ redirectTo: null });
    }
  });
});

/**
 * The part that makes six digits safe.
 *
 * A million combinations is nothing to a machine, so the only thing between a
 * guesser and somebody's account is that a code stops accepting guesses. These
 * tests do the guessing for real rather than trusting the counter.
 */
describe('guessing at a code', () => {
  it('dies after five wrong guesses, even for whoever holds the right one', async () => {
    await requestCode('victim@example.com');
    const real = signInCodeFor(server, 'victim@example.com');
    const wrong = aDifferentCode(real);

    for (let guess = 1; guess <= MAX_SIGN_IN_CODE_ATTEMPTS; guess += 1) {
      const response = await enterCode('victim@example.com', wrong);
      expect(response.status, `guess ${guess} should be refused`).toBe(401);
    }

    // The sixth attempt is the right code, arriving too late.
    const tooLate = await enterCode('victim@example.com', real);
    expect(tooLate.status).toBe(401);
    expect(await messageOf(tooLate)).toContain('not valid');
  });

  it('still lets the right code through on the fifth attempt, so the cap is five and not four', async () => {
    await requestCode('reader@example.com');
    const real = signInCodeFor(server, 'reader@example.com');
    const wrong = aDifferentCode(real);

    for (let guess = 1; guess < MAX_SIGN_IN_CODE_ATTEMPTS; guess += 1) {
      expect((await enterCode('reader@example.com', wrong)).status).toBe(401);
    }

    expect((await enterCode('reader@example.com', real)).status).toBe(200);
  });

  it('leaves nothing behind to keep guessing at', async () => {
    await requestCode('victim@example.com');
    const wrong = aDifferentCode(signInCodeFor(server, 'victim@example.com'));

    for (let guess = 0; guess < MAX_SIGN_IN_CODE_ATTEMPTS; guess += 1) {
      await enterCode('victim@example.com', wrong);
    }

    // Used, not merely counted: no row is left open to further guesses.
    const live = server.database.raw
      .prepare('select count(*) as count from sign_in_codes where used_at is null')
      .get() as { count: number };
    expect(live.count).toBe(0);
  });

  it('counts every guess, so hammering it cannot outrun the counter', async () => {
    await requestCode('victim@example.com');
    const wrong = aDifferentCode(signInCodeFor(server, 'victim@example.com'));

    await Promise.all(Array.from({ length: 20 }, () => enterCode('victim@example.com', wrong)));

    const row = server.database.raw.prepare('select attempts, used_at from sign_in_codes').get() as {
      attempts: number;
      used_at: string | null;
    };
    expect(row.attempts).toBeGreaterThanOrEqual(MAX_SIGN_IN_CODE_ATTEMPTS);
    expect(row.used_at).not.toBeNull();
  });

  it('gives a fresh five, and only five, when a new code is asked for', async () => {
    await requestCode('reader@example.com');
    const firstWrong = aDifferentCode(signInCodeFor(server, 'reader@example.com'));
    for (let guess = 0; guess < MAX_SIGN_IN_CODE_ATTEMPTS; guess += 1) {
      await enterCode('reader@example.com', firstWrong);
    }

    await requestCode('reader@example.com');
    expect(
      (await enterCode('reader@example.com', signInCodeFor(server, 'reader@example.com'))).status,
    ).toBe(200);
  });
});

describe('the codes themselves', () => {
  it('are six digits, keeping the ones that start with a zero rather than drawing again', async () => {
    // Three hundred draws is far past the rate limit, which exists precisely to
    // stop somebody doing this. Raised here rather than removed, because the
    // limit applying to the ordinary server is the thing worth keeping true.
    const roomy = createTestServer({ SIGNUP_MODE: 'open', MAX_AUTH_REQUESTS_PER_HOUR: '1000' });

    // Enough draws that a code starting with 0 is all but certain, which is what
    // catches a generator quietly skipping a tenth of its range.
    const codes: string[] = [];
    try {
      for (let index = 0; index < 300; index += 1) {
        const email = `person${index}@example.com`;
        await roomy.request('/api/auth/code', jsonBody({ email }));
        codes.push(signInCodeFor(roomy, email));
      }
    } finally {
      roomy.close();
    }

    expect(codes.every((code) => /^\d{6}$/.test(code))).toBe(true);
    expect(codes.some((code) => code.startsWith('0'))).toBe(true);
    // And they differ from each other, which a broken generator would not manage.
    expect(new Set(codes).size).toBeGreaterThan(codes.length - 10);
  });

  it('are never stored in a form that shows the digits', async () => {
    await requestCode('reader@example.com');
    const code = signInCodeFor(server, 'reader@example.com');

    const row = server.database.raw.prepare('select code_hash from sign_in_codes').get() as {
      code_hash: string;
    };
    expect(row.code_hash).not.toContain(code);
    expect(row.code_hash).toMatch(/^[0-9a-f]{64}$/);
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
    await requestCode('reader@example.com');
    const response = await enterCode(
      'reader@example.com',
      signInCodeFor(server, 'reader@example.com'),
      {
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
  it('offers email always, and Google only when it is configured', async () => {
    const response = await server.request('/api/auth/methods');
    expect(await response.json()).toMatchObject({ emailCode: true, google: false });
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
