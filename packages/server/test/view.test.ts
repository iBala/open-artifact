import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestServer, signIn, type TestServer, type SignedInUser } from './helpers/server.js';

/**
 * Serving an artifact's content.
 *
 * The page a reader opens is a screen in the web app. What the server serves is
 * the artifact itself, and everything that keeps it away from the reader's
 * session lives on this response.
 *
 * These check headers, and headers are not proof. The browser tests in
 * packages/e2e run the actual escape attempt.
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

function policyOf(response: Response): string {
  return response.headers.get('content-security-policy') ?? '';
}

async function makePublic(id: string): Promise<void> {
  await owner.as(`/api/artifacts/${id}/sharing/public`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ isPublic: true }),
  });
}

describe('what artifact content is allowed to do', () => {
  it('sandboxes itself, so opening the URL directly is no more powerful than the frame', async () => {
    const artifact = await owner.publish({ type: 'html', content: '<p>hi</p>' });
    const response = await owner.as(`/a/${artifact.slug}/content`);

    // Without allow-same-origin the document has an opaque origin: no cookies,
    // no same-origin requests to this server. The app also sets the sandbox
    // attribute on the frame, but this header is what covers somebody pasting
    // the URL into a tab, where there is no frame at all.
    expect(policyOf(response)).toContain('sandbox allow-scripts');
    expect(policyOf(response)).not.toContain('allow-same-origin');
  });

  it('blocks artifact script from calling anything over the network', async () => {
    const artifact = await owner.publish({ type: 'html', content: '<p>hi</p>' });
    const policy = policyOf(await owner.as(`/a/${artifact.slug}/content`));

    expect(policy).toContain("connect-src 'none'");
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("form-action 'none'");
    expect(policy).toContain("base-uri 'none'");
  });

  it('allows only self-contained images and fonts, so nothing leaks out through a URL', async () => {
    const artifact = await owner.publish({ type: 'html', content: '<p>hi</p>' });
    const policy = policyOf(await owner.as(`/a/${artifact.slug}/content`));

    expect(policy).toContain('img-src data: blob:');
    expect(policy).not.toMatch(/img-src[^;]*https:/);
  });

  it('lets the publisher own inline script and styles run inside the sandbox', async () => {
    const artifact = await owner.publish({ type: 'html', content: '<p>hi</p>' });
    const policy = policyOf(await owner.as(`/a/${artifact.slug}/content`));

    expect(policy).toContain("script-src 'unsafe-inline'");
    expect(policy).toContain("style-src 'unsafe-inline'");
  });
});

describe('the content itself', () => {
  it('serves the publisher HTML byte for byte', async () => {
    const content = '<html><body><h1>Dashboard</h1><script>console.log(1)</script></body></html>';
    const artifact = await owner.publish({ type: 'html', content });

    const response = await owner.as(`/a/${artifact.slug}/content`);
    expect(await response.text()).toBe(content);
    expect(response.headers.get('content-type')).toContain('text/html');
  });

  it('serves Markdown already rendered and sanitised, ready for the page', async () => {
    const artifact = await owner.publish({
      type: 'markdown',
      content:
        '# Weekly report\n\n<script>alert(1)</script>\n\n| Item | Count |\n| --- | --- |\n| Alpha | 2 |',
    });

    const html = await (await owner.as(`/a/${artifact.slug}/content`)).text();

    expect(html).toContain('<h1 id="weekly-report">Weekly report</h1>');
    expect(html).toContain('<table>');
    // The app puts this straight into its own page, so nothing that runs can be
    // allowed to survive this far.
    expect(html).not.toMatch(/<script/i);
  });

  it('never lets a browser guess a different content type', async () => {
    const artifact = await owner.publish({ type: 'html', content: '<p>hi</p>' });
    const response = await owner.as(`/a/${artifact.slug}/content`);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('sends no referrer, so the artifact URL does not travel to other sites', async () => {
    const artifact = await owner.publish({ type: 'html', content: '<p>hi</p>' });
    const response = await owner.as(`/a/${artifact.slug}/content`);
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('is never held by a shared cache', async () => {
    const artifact = await owner.publish({ type: 'markdown', content: '# Private thoughts' });
    const response = await owner.as(`/a/${artifact.slug}/content`);
    const cacheControl = response.headers.get('cache-control') ?? '';

    expect(cacheControl).toContain('no-store');
    expect(cacheControl).toContain('private');
  });

  it('sets no cookies on a content response', async () => {
    const artifact = await owner.publish({ type: 'html', content: '<p>hi</p>' });
    const response = await owner.as(`/a/${artifact.slug}/content`);
    expect(response.headers.get('set-cookie')).toBeNull();
  });
});

/**
 * A public Markdown artifact is read by strangers on this instance's own domain.
 * Its off-site links are rewritten to pass through the /leaving interstitial so a
 * reader is never carried silently to a site they did not choose. A private
 * artifact is served exactly as before.
 */
describe('off-site links in served Markdown', () => {
  const offSiteLink = '[open the report](https://evil.example.com/report)';

  it('sends an off-site link through /leaving once the artifact is public', async () => {
    const artifact = await owner.publish({ type: 'markdown', content: offSiteLink });
    await makePublic(artifact.id);

    const html = await (await server.request(`/a/${artifact.slug}/content`)).text();
    expect(html).toContain('href="/leaving?to=https%3A%2F%2Fevil.example.com%2Freport"');
    expect(html).not.toContain('href="https://evil.example.com/report"');
  });

  it('leaves the same off-site link untouched while the artifact is private', async () => {
    const artifact = await owner.publish({ type: 'markdown', content: offSiteLink });

    const html = await (await owner.as(`/a/${artifact.slug}/content`)).text();
    expect(html).toContain('href="https://evil.example.com/report"');
    expect(html).not.toContain('/leaving');
  });

  it('never rewrites a public HTML artifact, which is served byte for byte', async () => {
    const content = '<a href="https://evil.example.com/report">go</a>';
    const artifact = await owner.publish({ type: 'html', content });
    await makePublic(artifact.id);

    const html = await (await server.request(`/a/${artifact.slug}/content`)).text();
    expect(html).toBe(content);
  });
});

describe('who can fetch content', () => {
  it('nobody without access, and the answer says nothing about whether it exists', async () => {
    const artifact = await owner.publish({ type: 'markdown', content: '# Private plans' });
    const stranger = await signIn(server, 'stranger@elsewhere.test');

    const real = await stranger.as(`/a/${artifact.slug}/content`);
    const invented = await stranger.as('/a/aSlugThatNeverExisted/content');

    expect(real.status).toBe(404);
    expect(real.status).toBe(invented.status);
    expect(await real.text()).toBe(await invented.text());
  });

  it('anybody, once the artifact is public', async () => {
    const artifact = await owner.publish({ type: 'markdown', content: '# Read me' });
    await makePublic(artifact.id);

    const response = await server.request(`/a/${artifact.slug}/content`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Read me');
  });

  it('and a public artifact is still sandboxed exactly as hard', async () => {
    const artifact = await owner.publish({ type: 'html', content: '<h1>Dashboard</h1>' });
    await makePublic(artifact.id);

    // Being public changes who may read it, never what it is allowed to do.
    const policy = policyOf(await server.request(`/a/${artifact.slug}/content`));
    expect(policy).toContain('sandbox allow-scripts');
    expect(policy).toContain("connect-src 'none'");
  });
});

describe('reading an artifact by the slug in its URL', () => {
  it('returns the artifact and who published it, for the viewer title bar', async () => {
    const artifact = await owner.publish({ type: 'markdown', content: '# Quarterly report' });

    const response = await owner.as(`/api/artifacts/by-slug/${artifact.slug}`);
    expect(response.status).toBe(200);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      id: artifact.id,
      title: 'Quarterly report',
      ownerEmail: 'owner@example.com',
    });
  });

  it('is not mistaken for an artifact called by-slug', async () => {
    // /api/artifacts/:id would happily match "by-slug" as an id if this route
    // were registered after it.
    expect((await owner.as('/api/artifacts/by-slug/nothing-here')).status).toBe(404);
  });

  it('gives a stranger the same answer for a real slug and an invented one', async () => {
    const artifact = await owner.publish({ type: 'markdown', content: '# Private plans' });
    const stranger = await signIn(server, 'stranger@elsewhere.test');

    const real = await stranger.as(`/api/artifacts/by-slug/${artifact.slug}`);
    const invented = await stranger.as('/api/artifacts/by-slug/neverExisted');

    expect(real.status).toBe(invented.status);
    expect(await real.json()).toEqual(await invented.json());
  });

  it('gives a signed-out visitor the same answer, unless it is public', async () => {
    const artifact = await owner.publish({ type: 'markdown', content: '# Private plans' });

    const privateAnswer = await server.request(`/api/artifacts/by-slug/${artifact.slug}`);
    const invented = await server.request('/api/artifacts/by-slug/neverExisted');
    expect(privateAnswer.status).toBe(invented.status);
    expect(await privateAnswer.json()).toEqual(await invented.json());

    await makePublic(artifact.id);

    // Now it opens for anybody, which is what lets the app show a public
    // artifact without asking somebody to sign in first.
    expect((await server.request(`/api/artifacts/by-slug/${artifact.slug}`)).status).toBe(200);
  });
});
