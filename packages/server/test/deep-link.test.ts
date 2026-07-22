import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTestServer,
  signIn,
  jsonBody,
  magicLinkFor,
  type TestServer,
  type SignedInUser,
  type PublishedArtifact,
} from './helpers/server.js';

/**
 * Opening an artifact link while signed out.
 *
 * Somebody gets an email saying something was shared with them, clicks the link,
 * and is not signed in. Showing them a wall would waste the invitation, so they
 * are sent to sign in and brought straight back.
 *
 * The care needed: this must behave identically whether or not the artifact
 * exists. Redirecting for a real private artifact and refusing an invented slug
 * would turn the page into a way to ask "is there an artifact here?" and get an
 * honest answer without ever signing in.
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

const openAnonymously = (slug: string) =>
  server.request(`/a/${slug}`, { redirect: 'manual' });

describe('arriving at a shared link while signed out', () => {
  it('is sent to sign in, with the artifact remembered', async () => {
    const response = await openAnonymously(artifact.slug);

    expect(response.status).toBe(302);
    const location = response.headers.get('location') ?? '';
    expect(location).toContain('/login');
    expect(decodeURIComponent(location)).toContain(`/a/${artifact.slug}`);
  });

  it('lands on the artifact after signing in', async () => {
    await owner.as(`/api/artifacts/${artifact.id}/sharing/people`, jsonBody({
      email: 'colleague@example.com',
    }));

    // Follow the whole journey: the link, then sign-in, then back.
    const redirect = await openAnonymously(artifact.slug);
    const backTo = new URL(redirect.headers.get('location') ?? '', 'https://artifacts.test')
      .searchParams.get('redirectTo');

    await server.request('/api/auth/magic-link', jsonBody({
      email: 'colleague@example.com',
      redirectTo: backTo,
    }));

    const link = magicLinkFor(server, 'colleague@example.com');
    const verified = await server.request(link.pathname + link.search, { redirect: 'manual' });

    expect(verified.status).toBe(302);
    expect(verified.headers.get('location')).toBe(`/a/${artifact.slug}`);

    // And the artifact is actually there.
    const cookie = (verified.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const page = await server.request(`/a/${artifact.slug}`, { headers: { Cookie: cookie } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Quarterly report');
  });

  it('still shows nothing to somebody who signs in without access', async () => {
    // Being sent to sign in is not a promise that they will get in.
    const redirect = await openAnonymously(artifact.slug);
    expect(redirect.status).toBe(302);

    const stranger = await signIn(server, 'stranger@elsewhere.test');
    expect((await stranger.as(`/a/${artifact.slug}`)).status).toBe(404);
  });
});

describe('what the redirect gives away', () => {
  it('nothing: an invented slug is treated exactly like a real private one', async () => {
    const real = await openAnonymously(artifact.slug);
    const invented = await openAnonymously('thisSlugNeverExistedAtAll');

    expect(real.status).toBe(invented.status);

    // Same destination shape, differing only in the slug that was asked for.
    const realTarget = new URL(real.headers.get('location') ?? '', 'https://artifacts.test');
    const inventedTarget = new URL(invented.headers.get('location') ?? '', 'https://artifacts.test');
    expect(realTarget.pathname).toBe(inventedTarget.pathname);
    expect(await real.text()).toBe(await invented.text());
  });
});

describe('a public artifact', () => {
  it('opens without signing in at all', async () => {
    await owner.as(`/api/artifacts/${artifact.id}/sharing/public`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isPublic: true }),
    });

    const response = await openAnonymously(artifact.slug);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Quarterly report');
  });

  it('goes back to asking for sign-in once it is made private again', async () => {
    const setPublic = (isPublic: boolean) =>
      owner.as(`/api/artifacts/${artifact.id}/sharing/public`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isPublic }),
      });

    await setPublic(true);
    expect((await openAnonymously(artifact.slug)).status).toBe(200);

    await setPublic(false);
    expect((await openAnonymously(artifact.slug)).status).toBe(302);
  });
});

describe('the redirect target', () => {
  it('is a path on this instance, never anywhere else', async () => {
    // The sign-in flow refuses to send anybody off-site, but the value it is
    // handed should never be hostile in the first place.
    const response = await openAnonymously(artifact.slug);
    const target = new URL(response.headers.get('location') ?? '', 'https://artifacts.test')
      .searchParams.get('redirectTo');

    expect(target).toMatch(/^\/a\//);
    expect(target).not.toContain('//');
    expect(target).not.toContain(':');
  });
});
