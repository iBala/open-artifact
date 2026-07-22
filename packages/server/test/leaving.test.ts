import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestServer, type TestServer } from './helpers/server.js';

/**
 * The /leaving interstitial.
 *
 * A reader reaches it by clicking an off-site link inside a public artifact. It
 * shows where they are going and makes them click to continue. Its two jobs: show
 * a valid destination clearly, and never become an open redirect for anything
 * that is not an ordinary web link.
 */

let server: TestServer;

beforeEach(() => {
  server = createTestServer({ SIGNUP_MODE: 'open' });
});

afterEach(() => {
  server.close();
});

function leaving(to: string | null): Promise<Response> {
  const path = to === null ? '/leaving' : `/leaving?to=${encodeURIComponent(to)}`;
  return server.request(path);
}

describe('a valid destination', () => {
  it('shows the full URL and offers a continue link to it', async () => {
    const response = await leaving('https://example.com/x');
    expect(response.status).toBe(200);

    const html = await response.text();
    // The full address is shown as text so the reader can read where they go.
    expect(html).toContain('https://example.com/x');
    // The continue link points at the destination and carries the safe rel.
    expect(html).toContain('href="https://example.com/x"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });

  it('does not redirect on its own: the reader has to click', async () => {
    const response = await leaving('https://example.com/x');
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
  });
});

describe('anything that is not an ordinary web link', () => {
  const producesNoOutboundLink = (html: string) => {
    // No continue link at all: the only way the page ever links out is the anchor
    // that carries this rel, so its absence means nothing to click through to.
    expect(html).not.toContain('rel="noopener noreferrer nofollow"');
    expect(html).toContain('was not valid');
  };

  it('refuses a javascript: URL', async () => {
    const html = await (await leaving('javascript:alert(1)')).text();
    producesNoOutboundLink(html);
    expect(html).not.toContain('javascript:alert(1)');
  });

  it('refuses a data: URL', async () => {
    const html = await (await leaving('data:text/html,<script>alert(1)</script>')).text();
    producesNoOutboundLink(html);
    expect(html).not.toContain('data:text/html');
  });

  it('refuses a relative path, which has no absolute meaning here', async () => {
    const html = await (await leaving('/somewhere')).text();
    producesNoOutboundLink(html);
  });

  it('refuses a missing "to" param', async () => {
    const html = await (await leaving(null)).text();
    producesNoOutboundLink(html);
  });
});
