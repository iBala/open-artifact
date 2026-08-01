import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTestServer,
  jsonBody,
  signIn,
  type TestServer,
  type SignedInUser,
} from './helpers/server.js';
import type { CommentThread, CommentAnchor } from '@open-artifact/shared';

/**
 * What a client that shipped before element anchors makes of a thread today.
 *
 * The CLI installs from npm and stays on people's machines. Nobody upgrades it
 * because the server did. So the server has to keep answering the version that
 * is already out there, and this file is where that promise is kept honest.
 *
 * The shapes below are copied from the code that ships today, deliberately
 * rather than imported. Importing the current source would test the server
 * against itself and pass no matter what we changed.
 */

let server: TestServer;
let owner: SignedInUser;
let reader: SignedInUser;

beforeEach(async () => {
  server = createTestServer({ SIGNUP_MODE: 'open' });
  owner = await signIn(server, 'owner@example.com');
  reader = await signIn(server, 'reader@example.com');
});

afterEach(() => {
  server.close();
});

// ---------------------------------------------------------------------------
// The shipped CLI, as it stands
// ---------------------------------------------------------------------------

/** packages/cli/src/commands/comments.ts, as published. Do not "fix" this. */
function describeAnchorAsShippedCli(anchor: CommentAnchor): string {
  return anchor.kind === 'document'
    ? 'the whole document'
    : `"${(anchor as { snippet: string }).snippet}"`;
}

/** packages/web Comments.tsx, as published: quoted context only for text. */
function quotedContextAsShippedWeb(anchor: CommentAnchor): string | null {
  return anchor.kind === 'text' ? (anchor as { snippet: string }).snippet : null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PAGE = [
  '<!doctype html>',
  '<html><body>',
  '  <h1>Plans</h1>',
  '  <p id="pricing-note">The team plan starts at $49 per seat.</p>',
  '</body></html>',
].join('\n');

async function publish(content: string, type: 'markdown' | 'html'): Promise<string> {
  const artifact = await owner.publish({ type, content, title: 'Plans' });
  await owner.as(
    `/api/artifacts/${artifact.id}/sharing/people`,
    jsonBody({ email: 'reader@example.com' }),
  );
  return artifact.id;
}

async function commentOn(
  artifactId: string,
  body: string,
  position?: Record<string, unknown>,
): Promise<void> {
  const response = await reader.as(
    `/api/artifacts/${artifactId}/comments`,
    jsonBody(position ? { body, position } : { body }),
  );
  if (response.status !== 201) throw new Error(`comment failed: ${await response.text()}`);
}

async function threadsOn(artifactId: string): Promise<CommentThread[]> {
  const response = await reader.as(`/api/artifacts/${artifactId}/comments`);
  return ((await response.json()) as { threads: CommentThread[] }).threads;
}

async function republish(artifactId: string, content: string, baseVersion: number): Promise<void> {
  const response = await owner.as(`/api/artifacts/${artifactId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, baseVersion }),
  });
  if (!response.ok) throw new Error(`republish failed: ${await response.text()}`);
}

// ---------------------------------------------------------------------------

describe('a CLI that shipped before element anchors existed', () => {
  it('prints the passage for a comment on an HTML element, never "undefined"', async () => {
    const artifactId = await publish(PAGE, 'html');
    await commentOn(artifactId, 'this number is stale', {
      elementId: 'pricing-note',
      snippet: 'starts at $49 per seat',
    });

    const [thread] = await threadsOn(artifactId);
    const printed = describeAnchorAsShippedCli(thread!.anchor);

    expect(printed).not.toContain('undefined');
    expect(printed).toContain('starts at $49 per seat');
  });

  it('prints the element’s own words when the reader highlighted nothing', async () => {
    const artifactId = await publish(PAGE, 'html');
    await commentOn(artifactId, 'rewrite this', { elementId: 'pricing-note' });

    const [thread] = await threadsOn(artifactId);
    const printed = describeAnchorAsShippedCli(thread!.anchor);

    expect(printed).not.toContain('undefined');
    expect(printed).toContain('The team plan starts at $49 per seat.');
  });

  it('prints something readable for an element with no words at all', async () => {
    const chart = '<html><body><div id="chart"><canvas></canvas></div></body></html>';
    const artifactId = await publish(chart, 'html');
    await commentOn(artifactId, 'the axis is wrong', { elementId: 'chart' });

    const [thread] = await threadsOn(artifactId);
    const printed = describeAnchorAsShippedCli(thread!.anchor);

    expect(printed).not.toContain('undefined');
    expect(printed).toContain('chart');
  });

  it('still prints a document comment as the whole document', async () => {
    const artifactId = await publish(PAGE, 'html');
    await commentOn(artifactId, 'the tone is off');

    const [thread] = await threadsOn(artifactId);

    expect(describeAnchorAsShippedCli(thread!.anchor)).toBe('the whole document');
  });

  it('prints the passage for a thread that drifted', async () => {
    const artifactId = await publish(PAGE, 'html');
    await commentOn(artifactId, 'this number is stale', { elementId: 'pricing-note' });

    await republish(artifactId, PAGE.replace('$49', '$59'), 1);

    const [thread] = await threadsOn(artifactId);
    expect(thread!.anchorDrifted).toBe(true);
    expect(describeAnchorAsShippedCli(thread!.anchor)).not.toContain('undefined');
  });

  it('prints the passage for a Markdown thread that lost its place', async () => {
    // This one changed shape: a lost thread keeps its text anchor now, where it
    // used to become a document anchor. An old CLI must still read it.
    const artifactId = await publish('# Plans\n\nThe plan is $49 per seat.\n', 'markdown');
    await commentOn(artifactId, 'stale', { snippet: 'The plan is $49 per seat.' });

    await republish(artifactId, '# Plans\n\nContact us.\n', 1);

    const [thread] = await threadsOn(artifactId);
    expect(thread!.anchorLost).toBe(true);
    expect(describeAnchorAsShippedCli(thread!.anchor)).toContain('$49');
  });
});

describe('a web page cached before element anchors existed', () => {
  it('shows no quoted context for an element thread, rather than breaking', async () => {
    const artifactId = await publish(PAGE, 'html');
    await commentOn(artifactId, 'this number is stale', { elementId: 'pricing-note' });

    const [thread] = await threadsOn(artifactId);

    // Degraded on purpose: the old page has no idea what an element anchor is.
    // What matters is that reading it cannot throw.
    expect(quotedContextAsShippedWeb(thread!.anchor)).toBeNull();
  });

  it('still shows quoted context for every Markdown thread', async () => {
    const artifactId = await publish('# Plans\n\nThe plan is $49 per seat.\n', 'markdown');
    await commentOn(artifactId, 'stale', { snippet: 'The plan is $49 per seat.' });

    const [thread] = await threadsOn(artifactId);

    expect(quotedContextAsShippedWeb(thread!.anchor)).toContain('$49');
  });
});
