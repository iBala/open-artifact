import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createTestServer, TEST_BASE_URL, type TestServer } from './helpers/server.js';

/** The page the policy sends people to, read from the app that draws it. */
const SESSIONS_PAGE = readFileSync(
  fileURLToPath(new URL('../../web/src/pages/Sessions.tsx', import.meta.url)),
  'utf8',
);

/**
 * The privacy policy at /privacy, and its source at /privacy.md.
 *
 * A privacy policy has to be readable by somebody who has no account and runs no
 * JavaScript — a directory reviewer, a crawler, a person deciding whether to sign
 * up at all. And like /setup.md it has to describe the instance serving it rather
 * than a hardcoded one, because a self-hoster is the controller of their own data
 * and this page is what says so.
 *
 * The claims in the document are claims about this codebase. The ones asserted
 * here are the ones that would be a lie if the code changed underneath them.
 */

let server: TestServer;

afterEach(() => {
  server.close();
});

describe('/privacy', () => {
  beforeEach(() => {
    server = createTestServer();
  });

  it('is served publicly, as a page that needs no app to read', async () => {
    const response = await server.request('/privacy');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');

    const body = await response.text();
    expect(body).toContain('<!doctype html>');
    // Rendered server-side: the words are in the document, not fetched later.
    expect(body).toContain('Privacy policy');
    expect(body).toContain('<h2');
  });

  it('describes the instance serving it, not a hardcoded one', async () => {
    const body = await (await server.request('/privacy')).text();
    expect(body).toContain(new URL(TEST_BASE_URL).host);
    expect(body).not.toContain('open-artifact.com');
  });

  it('serves the same document as markdown at /privacy.md', async () => {
    const response = await server.request('/privacy.md');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/markdown');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await response.text()).toContain('# Privacy policy');
  });

  it('does not sit behind sign-in', async () => {
    // No cookie, no token, no account. Both addresses still answer.
    for (const path of ['/privacy', '/privacy.md']) {
      expect((await server.request(path)).status).toBe(200);
    }
  });
});

describe('the privacy contact', () => {
  it('is printed when the operator has set one', async () => {
    server = createTestServer({ PRIVACY_CONTACT_EMAIL: 'privacy@artifacts.test' });
    const body = await (await server.request('/privacy.md')).text();
    expect(body).toContain('privacy@artifacts.test');
  });

  it('says so plainly when the operator has not, rather than inventing one', async () => {
    server = createTestServer();
    const body = await (await server.request('/privacy.md')).text();
    expect(body).toContain('has not published a contact address');
    expect(body).not.toMatch(/[\w.]+@[\w.]+\.\w+/);
  });
});

describe('the route it gives for deleting an account', () => {
  beforeEach(() => {
    server = createTestServer();
  });

  /**
   * The policy tells somebody where to go to exercise a right, so the place it
   * names has to be the place that exists. It said "Settings → Sessions" for a
   * while, which is the URL, not anything a person can see: the page is reached
   * by clicking your own name and it is headed "Where you are signed in".
   */
  it('names the heading the page actually carries', async () => {
    const body = await (await server.request('/privacy.md')).text();
    expect(body).toContain('Where you are signed in');
    expect(SESSIONS_PAGE).toContain('Where you are signed in');
  });

  it('names the button that actually closes the account', async () => {
    const body = await (await server.request('/privacy.md')).text();
    expect(body).toContain('Close this account');
    expect(SESSIONS_PAGE).toContain('Close this account');
  });

  it('does not send anybody to a Settings menu, which there is not one of', async () => {
    const body = await (await server.request('/privacy.md')).text();
    expect(body).not.toContain('Settings →');
  });
});

describe('the directory domain-verification proof', () => {
  it('serves the configured value verbatim, as plain text', async () => {
    server = createTestServer({ OPENAI_APPS_CHALLENGE: 'abc123-verification-value' });
    const response = await server.request('/.well-known/openai-apps-challenge');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    // Verbatim: a directory compares the body byte for byte.
    expect(await response.text()).toBe('abc123-verification-value');
  });

  it('does not exist when no value is configured', async () => {
    server = createTestServer();
    expect((await server.request('/.well-known/openai-apps-challenge')).status).toBe(404);
  });
});

describe('what the policy claims about this instance', () => {
  it('names a mail provider only when the instance actually sends mail', async () => {
    server = createTestServer();
    const withoutMail = await (await server.request('/privacy.md')).text();
    expect(withoutMail).toContain('no mail provider configured');
    server.close();

    server = createTestServer({
      SMTP_HOST: 'smtp.artifacts.test',
      MAIL_FROM: 'Open Artifact <no-reply@artifacts.test>',
    });
    const withMail = await (await server.request('/privacy.md')).text();
    expect(withMail).toContain('sent over SMTP');
  });

  it('claims no analytics, and the app shell backs that up', async () => {
    server = createTestServer();
    const body = await (await server.request('/privacy.md')).text();
    expect(body).toContain('no analytics');

    // If a tracker were ever added this claim would become false, so the
    // document and the shell are asserted together.
    const shell = await (await server.request('/privacy')).text();
    expect(shell).not.toMatch(/googletagmanager|posthog|sentry|plausible|mixpanel/i);
  });
});
