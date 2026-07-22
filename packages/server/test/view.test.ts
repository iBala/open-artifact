import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTestServer,
  signIn,
  type TestServer,
  type SignedInUser,
} from './helpers/server.js';

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

describe('the artifact page', () => {
  it('renders a Markdown artifact into the page itself', async () => {
    const artifact = await owner.publish({
      type: 'markdown',
      content: '# Weekly report\n\n| Item | Count |\n| --- | --- |\n| Alpha | 2 |',
    });

    const response = await owner.as(`/a/${artifact.slug}`);
    expect(response.status).toBe(200);

    const html = await response.text();
    expect(html).toContain('<h1 id="weekly-report">Weekly report</h1>');
    expect(html).toContain('<table>');
    // Markdown is safe in the page, so it does not need a frame.
    expect(html).not.toContain('<iframe');
  });

  it('puts an HTML artifact in a sandboxed frame instead of the page', async () => {
    const artifact = await owner.publish({
      type: 'html',
      content: '<html><body><script>window.x=1</script>Dashboard</body></html>',
    });

    const html = await (await owner.as(`/a/${artifact.slug}`)).text();
    expect(html).toContain(`src="/a/${artifact.slug}/content"`);
    expect(html).toContain('sandbox="allow-scripts"');
    // allow-same-origin would hand the artifact our origin, which is the whole risk.
    expect(html).not.toContain('allow-same-origin');
    // The publisher's script must never be inlined into our page.
    expect(html).not.toContain('window.x=1');
  });

  it('escapes the title, so a hostile title cannot inject markup into the chrome', async () => {
    const artifact = await owner.publish({
      type: 'markdown',
      content: '# hello',
      title: '</title><script>alert(1)</script>',
    });

    const html = await (await owner.as(`/a/${artifact.slug}`)).text();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('returns not_found for a slug that does not exist', async () => {
    expect((await owner.as('/a/doesnotexistdoesnotexist')).status).toBe(404);
  });

  it('is never cached by a shared cache and never sent to a search index', async () => {
    const artifact = await owner.publish({ type: 'markdown', content: '# Private thoughts' });
    const response = await owner.as(`/a/${artifact.slug}`);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('cache-control')).toContain('private');
    expect(await response.text()).toContain('noindex');
  });
});

describe('the content endpoint', () => {
  it('sandboxes itself, so opening the URL directly is no more powerful than the frame', async () => {
    const artifact = await owner.publish({ type: 'html', content: '<p>hi</p>' });
    const response = await owner.as(`/a/${artifact.slug}/content`);

    // Without allow-same-origin the document has an opaque origin: no cookies,
    // no same-origin requests to this server.
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

  it('lets the publisher’s own inline script and styles run inside the sandbox', async () => {
    const artifact = await owner.publish({ type: 'html', content: '<p>hi</p>' });
    const policy = policyOf(await owner.as(`/a/${artifact.slug}/content`));

    expect(policy).toContain("script-src 'unsafe-inline'");
    expect(policy).toContain("style-src 'unsafe-inline'");
  });

  it('serves the publisher’s HTML byte for byte', async () => {
    const content = '<html><body><h1>Dashboard</h1><script>console.log(1)</script></body></html>';
    const artifact = await owner.publish({ type: 'html', content });

    const response = await owner.as(`/a/${artifact.slug}/content`);
    expect(await response.text()).toBe(content);
    expect(response.headers.get('content-type')).toContain('text/html');
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

  it('sets no cookies on a content response', async () => {
    const artifact = await owner.publish({ type: 'html', content: '<p>hi</p>' });
    const response = await owner.as(`/a/${artifact.slug}/content`);
    expect(response.headers.get('set-cookie')).toBeNull();
  });
});

describe('the page around the content', () => {
  it('loads no script of its own and no third-party asset', async () => {
    const artifact = await owner.publish({ type: 'markdown', content: '# Report' });
    const response = await owner.as(`/a/${artifact.slug}`);
    const policy = policyOf(response);

    expect(policy).toContain("default-src 'none'");
    expect(policy).not.toContain('script-src');
    expect(await response.text()).not.toMatch(/<script/i);
  });
});
