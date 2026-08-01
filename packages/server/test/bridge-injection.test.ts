import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTestServer,
  jsonBody,
  signIn,
  type TestServer,
  type SignedInUser,
  type PublishedArtifact,
} from './helpers/server.js';
import { BRIDGE_CHANNEL } from '../src/comments/bridge.js';

/**
 * Putting the comment bridge into an artifact, and keeping it out of everything
 * else.
 *
 * The rule this file holds: the framed copy of an HTML artifact carries the
 * bridge, and every other way of reading that artifact returns the publisher's
 * bytes and nothing else. That is what keeps "we never modify the publisher's
 * HTML" true where it is checked — a pasted URL, an API read, a download.
 */

const PAGE = '<!doctype html>\n<html><body><p id="a">Some words here.</p></body></html>';

let server: TestServer;
let owner: SignedInUser;
let reader: SignedInUser;
let stranger: SignedInUser;
let artifact: PublishedArtifact;

beforeEach(async () => {
  server = createTestServer({ SIGNUP_MODE: 'open' });
  owner = await signIn(server, 'owner@example.com');
  reader = await signIn(server, 'reader@example.com');
  stranger = await signIn(server, 'stranger@example.com');
  artifact = await owner.publish({ type: 'html', content: PAGE, title: 'Plans' });
  await owner.as(
    `/api/artifacts/${artifact.id}/sharing/people`,
    jsonBody({ email: 'reader@example.com' }),
  );
});

afterEach(() => {
  server.close();
});

const content = (as: SignedInUser, query = '') =>
  as.as(`/a/${artifact.slug}/content${query}`);

describe('the framed copy', () => {
  it('carries the bridge for somebody who can comment', async () => {
    const body = await (await content(reader, '?frame=1')).text();

    expect(body).toContain(BRIDGE_CHANNEL);
  });

  it('appends the bridge rather than inserting it', async () => {
    // Inserting would mean finding a place in the publisher's document, which
    // means parsing and rewriting it. Appending cannot move the doctype or drop
    // the page into quirks mode.
    const body = await (await content(reader, '?frame=1')).text();

    expect(body.startsWith(PAGE)).toBe(true);
    expect(body.indexOf(BRIDGE_CHANNEL)).toBeGreaterThan(PAGE.length - 1);
  });

  it('leaves the artifact’s own bytes untouched', async () => {
    const body = await (await content(reader, '?frame=1')).text();

    expect(body.slice(0, PAGE.length)).toBe(PAGE);
  });
});

describe('every other way of reading the same artifact', () => {
  it('gives back exactly what was published, byte for byte', async () => {
    const body = await (await content(reader)).text();

    expect(body).toBe(PAGE);
  });

  it('gives nothing extra to a pasted framed URL from somebody who cannot comment', async () => {
    // The parameter is guessable. It has to be the access check that decides,
    // not the address.
    const madePublic = await owner.as(`/api/artifacts/${artifact.id}/sharing/public`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isPublic: true }),
    });
    expect(madePublic.status).toBe(200);

    const body = await (await content(stranger, '?frame=1')).text();

    expect(body).toBe(PAGE);
    expect(body).not.toContain(BRIDGE_CHANNEL);
  });

  it('never puts a bridge in a Markdown artifact', async () => {
    const markdown = await owner.publish({ type: 'markdown', content: '# Plans\n\nA line.\n' });
    const response = await owner.as(`/a/${markdown.slug}/content?frame=1`);

    expect(await response.text()).not.toContain(BRIDGE_CHANNEL);
  });
});

describe('the headers that make the frame safe', () => {
  it('keeps the sandbox and the content policy on the framed copy', async () => {
    const response = await content(reader, '?frame=1');
    const policy = response.headers.get('content-security-policy') ?? '';

    expect(policy).toContain('sandbox allow-scripts');
    expect(policy).toContain("connect-src 'none'");
    expect(policy).toContain("default-src 'none'");
  });

  it('keeps them identical with and without the bridge', async () => {
    const framed = await content(reader, '?frame=1');
    const plain = await content(reader);

    expect(framed.headers.get('content-security-policy')).toBe(
      plain.headers.get('content-security-policy'),
    );
    expect(framed.headers.get('x-frame-options')).toBe(plain.headers.get('x-frame-options'));
    expect(framed.headers.get('cache-control')).toBe(plain.headers.get('cache-control'));
  });
});

describe('the bridge itself', () => {
  it('refuses to do anything outside a frame', async () => {
    // Somebody can paste the framed URL into a tab. There is no app there, and a
    // script left listening for messages from anybody would be a gift.
    const body = await (await content(reader, '?frame=1')).text();

    expect(body).toContain('window.parent === window');
  });

  it('never sends the text of what was selected', async () => {
    // The channel carries a handle. A hostile page with a text channel into the
    // app's own chrome can write "your session has expired" in the app's voice.
    const body = await (await content(reader, '?frame=1')).text();
    const script = body.slice(body.indexOf('<script>'));

    expect(script).not.toContain('textContent');
    expect(script).not.toContain('innerText');
    expect(script).not.toContain('innerHTML');
  });

  it('does not add anything to the publisher’s document to highlight', async () => {
    const body = await (await content(reader, '?frame=1')).text();
    const script = body.slice(body.indexOf('<script>'));

    expect(script).not.toContain('createElement');
    expect(script).not.toContain('appendChild');
    expect(script).not.toContain('surroundContents');
    expect(script).toContain('style.outline');
  });
});
