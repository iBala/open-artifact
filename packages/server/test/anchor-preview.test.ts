import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTestServer,
  jsonBody,
  signIn,
  type TestServer,
  type SignedInUser,
  type PublishedArtifact,
} from './helpers/server.js';

/**
 * Resolving an element before anybody writes a comment about it.
 *
 * Why this route exists: the reader selects inside a sandboxed frame showing a
 * stranger's page. The frame is allowed to say *which element*; it is never
 * allowed to say what that element says. The app asks here instead, so what
 * appears in its own chrome came from the stored source and not from the page.
 */

const PAGE = [
  '<!doctype html>',
  '<html><body>',
  '  <h1>Plans</h1>',
  '  <p id="pricing-note">The team plan starts at $49 per seat.</p>',
  '  <div><canvas></canvas></div>',
  '</body></html>',
].join('\n');

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

const preview = (as: SignedInUser, position: Record<string, unknown>) =>
  as.as(`/api/artifacts/${artifact.id}/anchor-preview`, jsonBody(position));

describe('previewing an element anchor', () => {
  it('answers with the stored source, not with anything the caller sent', async () => {
    const response = await preview(reader, {
      elementId: 'pricing-note',
      snippet: 'YOUR SESSION HAS EXPIRED',
    });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.found).toBe(true);
    expect(body.tag).toBe('p');
    expect(body.startLine).toBe(4);
    expect(body.version).toBe(1);
  });

  it('quotes the element’s own words when nothing was highlighted', async () => {
    const response = await preview(reader, { elementId: 'pricing-note' });
    const body = (await response.json()) as { snippet: string };

    expect(body.snippet).toBe('The team plan starts at $49 per seat.');
  });

  it('says an element cannot be anchored to, without failing the request', async () => {
    // The composer needs to tell the reader before they type, not after.
    const response = await preview(reader, { elementId: 'nothing-here' });
    const body = (await response.json()) as { found: boolean; reason: string };

    expect(response.status).toBe(200);
    expect(body.found).toBe(false);
    expect(body.reason).toBe('not-found');
  });

  it('refuses an element with no id and almost no text, and says which', async () => {
    const response = await preview(reader, { path: '0/1/2' });
    const body = (await response.json()) as { found: boolean; reason: string };

    expect(body.found).toBe(false);
    expect(body.reason).toBe('too-little-text');
  });

  it('needs comment access, not merely view access', async () => {
    const response = await preview(stranger, { elementId: 'pricing-note' });

    expect(response.status).toBe(404);
  });

  it('has nothing to say about a Markdown artifact', async () => {
    const markdown = await owner.publish({ type: 'markdown', content: '# Plans\n\nA line.\n' });
    const response = await owner.as(
      `/api/artifacts/${markdown.id}/anchor-preview`,
      jsonBody({ elementId: 'anything' }),
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('Markdown');
  });
});

// ---------------------------------------------------------------------------
// Commenting against a version that moved on
// ---------------------------------------------------------------------------

describe('a comment written while the page was being republished', () => {
  async function republish(content: string, baseVersion: number): Promise<void> {
    const response = await owner.as(`/api/artifacts/${artifact.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, baseVersion }),
    });
    expect(response.status).toBe(200);
  }

  it('is refused when the reader names the version they were looking at', async () => {
    await republish(PAGE.replace('$49', '$59'), 1);

    const response = await reader.as(
      `/api/artifacts/${artifact.id}/comments`,
      jsonBody({
        body: 'this number is stale',
        position: { elementId: 'pricing-note' },
        baseVersion: 1,
      }),
    );

    expect(response.status).toBe(409);
    expect(await response.text()).toContain('changed while you were reading it');
  });

  it('is accepted when the version still matches', async () => {
    const response = await reader.as(
      `/api/artifacts/${artifact.id}/comments`,
      jsonBody({
        body: 'this number is stale',
        position: { elementId: 'pricing-note' },
        baseVersion: 1,
      }),
    );

    expect(response.status).toBe(201);
  });

  it('still accepts a client that does not name a version at all', async () => {
    // Everything that shipped before this check exists.
    await republish(PAGE.replace('$49', '$59'), 1);

    const response = await reader.as(
      `/api/artifacts/${artifact.id}/comments`,
      jsonBody({ body: 'this number is stale', position: { elementId: 'pricing-note' } }),
    );

    expect(response.status).toBe(201);
  });

  it('does not hold a document-level comment to a version', async () => {
    await republish(PAGE.replace('$49', '$59'), 1);

    const response = await reader.as(
      `/api/artifacts/${artifact.id}/comments`,
      jsonBody({ body: 'the tone is off', baseVersion: 1 }),
    );

    expect(response.status).toBe(201);
  });
});
