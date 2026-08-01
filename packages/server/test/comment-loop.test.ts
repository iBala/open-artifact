import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTestServer,
  signIn,
  jsonBody,
  type TestServer,
  type SignedInUser,
} from './helpers/server.js';

/**
 * The whole loop, once, on an HTML page.
 *
 * Every other test in this feature holds one piece down. This one is the product
 * described in a single reading: an agent publishes a page, a person marks the
 * part that is wrong, the agent reads that back as source it can edit, fixes it,
 * says what it did, and the person settles the thread.
 *
 * If this test passes and the feature is still broken, the test is wrong.
 */

const PAGE = [
  '<!doctype html>',
  '<html><body>',
  '  <h1>Plans</h1>',
  '  <section id="pricing">',
  '    <p id="pricing-note">The team plan starts at $49 per seat, billed yearly.</p>',
  '  </section>',
  '</body></html>',
].join('\n');

let server: TestServer;
let owner: SignedInUser;
let reader: SignedInUser;
let token: string;

beforeEach(async () => {
  server = createTestServer({ SIGNUP_MODE: 'open' });
  owner = await signIn(server, 'owner@example.com');
  reader = await signIn(server, 'reader@example.com');

  const connected = await owner.as('/api/auth/mcp-tokens', jsonBody({ label: 'Claude on the web' }));
  token = ((await connected.json()) as { token: string }).token;
});

afterEach(() => {
  server.close();
});

async function tool(name: string, args: Record<string, unknown>): Promise<string> {
  const response = await server.request('/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = (await response.json()) as { result?: { content: { text: string }[] } };
  return body.result?.content.map((part) => part.text).join('\n') ?? '';
}

describe('a person marks what is wrong and the agent fixes it', () => {
  it('walks the whole way round', async () => {
    // 1. The agent publishes, with an id on the block it expects to be discussed.
    const published = await tool('publish_artifact', {
      content: PAGE,
      format: 'html',
      title: 'Plans',
    });
    const artifactId = /artifact_id: (\S+)/.exec(published)?.[1] ?? '';
    expect(artifactId).not.toBe('');

    await tool('share_artifact', { artifact_id: artifactId, email: 'reader@example.com' });

    // 2. A person marks the sentence that is wrong.
    const started = await reader.as(
      `/api/artifacts/${artifactId}/comments`,
      jsonBody({
        body: 'This number is stale, we moved to $59 last month.',
        position: { elementId: 'pricing-note', snippet: 'starts at $49 per seat' },
        baseVersion: 1,
      }),
    );
    expect(started.status).toBe(201);
    const threadId = ((await started.json()) as { id: string }).id;

    // 3. The agent reads it back and is told the place, not only the words.
    const listed = await tool('list_comments', { artifact_id: artifactId });
    expect(listed).toContain('This number is stale');
    expect(listed).toContain('<p id="pricing-note">');
    expect(listed).toContain('The team plan starts at $49 per seat, billed yearly.');
    expect(listed).toMatch(/lines \d+-\d+/);

    // 4. It changes that element and keeps the id, which is what it was asked to do.
    const fixed = await tool('update_artifact', {
      artifact_id: artifactId,
      base_version: 1,
      content: PAGE.replace('$49', '$59'),
    });
    expect(fixed).toContain('version 2');

    // 5. The thread is still on that element, and says the words moved under it.
    const afterFix = await tool('list_comments', { artifact_id: artifactId });
    expect(afterFix).not.toMatch(/lost/i);
    expect(afterFix).toContain('$59');
    expect(afterFix).toMatch(/changed since the comment was written/i);

    // 6. The agent says what it did, on the thread.
    await tool('reply_to_comment', {
      thread_id: threadId,
      body: 'Updated to $59 per seat.',
    });

    // 7. The person who raised it settles it.
    const resolved = await reader.as(`/api/comments/threads/${threadId}/status`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'resolved' }),
    });
    expect(resolved.status).toBe(200);

    // 8. Next time the agent looks, there is nothing open waiting for it.
    expect(await tool('list_comments', { artifact_id: artifactId, status: 'open' })).toContain(
      'No comments yet',
    );

    const settled = await tool('list_comments', { artifact_id: artifactId, status: 'resolved' });
    expect(settled).toContain('Updated to $59 per seat.');
  });

  it('lets the agent ask only for what happened since it last looked', async () => {
    const published = await tool('publish_artifact', { content: PAGE, format: 'html' });
    const artifactId = /artifact_id: (\S+)/.exec(published)?.[1] ?? '';
    await tool('share_artifact', { artifact_id: artifactId, email: 'reader@example.com' });

    await reader.as(
      `/api/artifacts/${artifactId}/comments`,
      jsonBody({ body: 'the old one', position: { elementId: 'pricing-note' } }),
    );

    const checkpoint = new Date(Date.now() + 1000).toISOString();
    expect(await tool('list_comments', { artifact_id: artifactId, since: checkpoint })).toContain(
      'Nothing new since',
    );

    await reader.as(
      `/api/artifacts/${artifactId}/comments`,
      jsonBody({ body: 'and a new one', position: { elementId: 'pricing' } }),
    );

    const since = await tool('list_comments', {
      artifact_id: artifactId,
      since: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(since).toContain('and a new one');
  });
});

describe('the people around the loop are told what happened', () => {
  it('notifies the owner of a comment on an element of their page', async () => {
    const published = await tool('publish_artifact', { content: PAGE, format: 'html' });
    const artifactId = /artifact_id: (\S+)/.exec(published)?.[1] ?? '';
    await tool('share_artifact', { artifact_id: artifactId, email: 'reader@example.com' });

    await reader.as(
      `/api/artifacts/${artifactId}/comments`,
      jsonBody({
        body: 'Can you look at this, @owner@example.com?',
        position: { elementId: 'pricing-note' },
      }),
    );

    const inbox = (await (await owner.as('/api/notifications')).json()) as {
      notifications: { type: string; threadId: string | null }[];
    };
    const mention = inbox.notifications.find((entry) => entry.type === 'mention');

    expect(mention).toBeTruthy();
    expect(mention?.threadId).toBeTruthy();
  });
});
