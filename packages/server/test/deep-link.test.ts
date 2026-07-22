import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTestServer,
  signIn,
  jsonBody,
  signInCodeFor,
  type TestServer,
  type SignedInUser,
  type PublishedArtifact,
} from './helpers/server.js';

/**
 * Following an artifact link while signed out.
 *
 * Somebody gets an email saying something was shared with them and clicks the
 * link. The page they land on is a screen in the web app, so the app is what
 * decides whether to show the artifact or ask them to sign in. It decides by
 * asking this API, which means the property that matters is a property of these
 * responses:
 *
 *   A private artifact and an artifact that does not exist must be
 *   indistinguishable to somebody who cannot see them.
 *
 * If they differed, anybody could learn which artifact addresses are real by
 * trying them, without ever signing in. The journey through the browser is
 * covered by the end-to-end tests; what is checked here is that the server never
 * hands the app enough to tell the two apart.
 */

let server: TestServer;
let owner: SignedInUser;
let artifact: PublishedArtifact;

beforeEach(async () => {
  server = createTestServer({ SIGNUP_MODE: 'open' });
  owner = await signIn(server, 'owner@example.com');
  artifact = await owner.publish({ type: 'markdown', content: '# Quarterly report' });
});

afterEach(() => {
  server.close();
});

const anonymously = (path: string) => server.request(path);

async function setPublic(isPublic: boolean): Promise<void> {
  await owner.as(`/api/artifacts/${artifact.id}/sharing/public`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ isPublic }),
  });
}

describe('what a signed-out visitor can learn', () => {
  it('nothing: a real private artifact answers exactly like an invented one', async () => {
    const real = await anonymously(`/api/artifacts/by-slug/${artifact.slug}`);
    const invented = await anonymously('/api/artifacts/by-slug/thisNeverExistedAtAll');

    expect(real.status).toBe(invented.status);
    expect(await real.json()).toEqual(await invented.json());
  });

  it('and the same holds for the content itself', async () => {
    const real = await anonymously(`/a/${artifact.slug}/content`);
    const invented = await anonymously('/a/thisNeverExistedAtAll/content');

    expect(real.status).toBe(invented.status);
    expect(await real.text()).toBe(await invented.text());
  });

  it('and nothing of the artifact appears in either answer', async () => {
    const response = await anonymously(`/api/artifacts/by-slug/${artifact.slug}`);
    expect(await response.text()).not.toContain('Quarterly report');
  });
});

describe('signing in from that link', () => {
  it('lands the person on the artifact they were trying to open', async () => {
    await owner.as(
      `/api/artifacts/${artifact.id}/sharing/people`,
      jsonBody({ email: 'colleague@example.com' }),
    );

    // The app asks for a code, carrying where they were headed.
    const target = `/a/${artifact.slug}`;
    await server.request('/api/auth/code', jsonBody({ email: 'colleague@example.com', redirectTo: target }));

    const verified = await server.request(
      '/api/auth/verify-code',
      jsonBody({ email: 'colleague@example.com', code: signInCodeFor(server, 'colleague@example.com') }),
    );

    expect(verified.status).toBe(200);
    // The server hands back where to go, so the app does not have to remember
    // across a page load it may not survive.
    expect((await verified.json()) as { redirectTo: string }).toEqual({ redirectTo: target });

    const cookie = (verified.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const response = await server.request(`/api/artifacts/by-slug/${artifact.slug}`, {
      headers: { Cookie: cookie },
    });
    expect(response.status).toBe(200);
  });

  it('still shows nothing to somebody who signs in without access', async () => {
    // Being invited to sign in is not a promise that they will get in.
    const stranger = await signIn(server, 'stranger@elsewhere.test');
    expect((await stranger.as(`/api/artifacts/by-slug/${artifact.slug}`)).status).toBe(404);
  });

  it('never carries the person off this instance', async () => {
    for (const hostile of ['https://evil.example.com', '//evil.example.com', 'javascript:alert(1)']) {
      server.mailer.clear();
      await server.request('/api/auth/code', jsonBody({ email: 'reader@example.com', redirectTo: hostile }));

      const verified = await server.request(
        '/api/auth/verify-code',
        jsonBody({ email: 'reader@example.com', code: signInCodeFor(server, 'reader@example.com') }),
      );

      expect((await verified.json()) as { redirectTo: string | null }).toEqual({ redirectTo: null });
    }
  });
});

describe('a public artifact', () => {
  it('opens for somebody with no account at all', async () => {
    await setPublic(true);

    const response = await anonymously(`/api/artifacts/by-slug/${artifact.slug}`);
    expect(response.status).toBe(200);
    expect((await response.json()) as { title: string }).toMatchObject({
      title: 'Quarterly report',
    });
  });

  it('goes back to giving nothing away once it is private again', async () => {
    await setPublic(true);
    expect((await anonymously(`/api/artifacts/by-slug/${artifact.slug}`)).status).toBe(200);

    await setPublic(false);

    const real = await anonymously(`/api/artifacts/by-slug/${artifact.slug}`);
    const invented = await anonymously('/api/artifacts/by-slug/neverExisted');
    expect(real.status).toBe(invented.status);
    expect(await real.json()).toEqual(await invented.json());
  });
});
