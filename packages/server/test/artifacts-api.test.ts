import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTestServer,
  signIn,
  TEST_BASE_URL,
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

function post(body: unknown, init: RequestInit = {}): Promise<Response> {
  return owner.as('/api/artifacts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...init,
  });
}

describe('publishing an artifact', () => {
  it('accepts Markdown and returns everything the publisher needs', async () => {
    const response = await post({ type: 'markdown', content: '# Weekly report\n\nAll good.' });
    expect(response.status).toBe(201);

    const artifact = (await response.json()) as Record<string, unknown>;
    expect(artifact.id).toMatch(/^art_/);
    expect(artifact.type).toBe('markdown');
    expect(artifact.title).toBe('Weekly report');
    expect(artifact.version).toBe(1);
    expect(artifact.url).toBe(`${TEST_BASE_URL}/a/${String(artifact.slug)}`);
    expect(artifact.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  it('accepts HTML', async () => {
    const artifact = await owner.publish({
      type: 'html',
      content: '<html><head><title>Dashboard</title></head><body>hi</body></html>',
    });
    expect(artifact.title).toBe('Dashboard');
  });

  it('keeps a title the publisher set instead of deriving one', async () => {
    const artifact = await owner.publish({
      type: 'markdown',
      content: '# Derived heading',
      title: 'Chosen title',
    });
    expect(artifact.title).toBe('Chosen title');
  });

  it('refuses a file type it cannot render safely', async () => {
    const response = await post({ type: 'pdf', content: 'x' });
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe('unsupported_type');
  });

  it('refuses an artifact larger than this instance allows, and says the limit', async () => {
    const small = createTestServer({ MAX_ARTIFACT_BYTES: '2048', SIGNUP_MODE: 'open' });
    try {
      const publisher = await signIn(small, 'publisher@example.com');
      const response = await publisher.as('/api/artifacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'markdown', content: 'x'.repeat(3000) }),
      });
      expect(response.status).toBe(413);
      const body = (await response.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('payload_too_large');
      expect(body.error.message).toContain('2.0 KB');
    } finally {
      small.close();
    }
  });

  it('refuses empty content', async () => {
    expect(await errorCode(await post({ type: 'markdown', content: '' }))).toBe(
      'validation_failed',
    );
  });

  it('refuses a blank title rather than silently deriving one', async () => {
    expect(
      await errorCode(await post({ type: 'markdown', content: '# Hi', title: '   ' })),
    ).toBe('validation_failed');
  });

  it('refuses a body that is not JSON', async () => {
    const response = await owner.as('/api/artifacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json at all',
    });
    expect(await errorCode(response)).toBe('validation_failed');
  });

  it('gives every artifact a different unguessable slug', async () => {
    const slugs = new Set<string>();
    for (let index = 0; index < 25; index += 1) {
      const artifact = await owner.publish({ type: 'markdown', content: `# Report ${index}` });
      expect(artifact.slug).toMatch(/^[0-9a-zA-Z]{24}$/);
      slugs.add(artifact.slug);
    }
    expect(slugs.size).toBe(25);
  });
});

describe('reading an artifact', () => {
  it('returns the artifact with its content', async () => {
    const created = await owner.publish({ type: 'markdown', content: '# Hello' });
    const response = await owner.as(`/api/artifacts/${created.id}`);
    expect(response.status).toBe(200);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      id: created.id,
      content: '# Hello',
      version: 1,
    });
  });

  it('returns not_found for an id that does not exist', async () => {
    const response = await owner.as('/api/artifacts/art_doesnotexist');
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe('not_found');
  });

  it('lists artifacts newest first', async () => {
    await owner.publish({ type: 'markdown', content: '# First' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await owner.publish({ type: 'markdown', content: '# Second' });

    const response = await owner.as('/api/artifacts');
    const body = (await response.json()) as { artifacts: { title: string }[] };
    expect(body.artifacts.map((artifact) => artifact.title)).toEqual(['Second', 'First']);
  });
});

describe('updating an artifact', () => {
  it('replaces the content and keeps the same URL', async () => {
    const created = await owner.publish({ type: 'markdown', content: '# First draft' });

    const response = await update(created.id, { content: '# Second draft', baseVersion: 1 });
    expect(response.status).toBe(200);

    const updated = (await response.json()) as Record<string, unknown>;
    expect(updated.slug).toBe(created.slug);
    expect(updated.url).toBe(created.url);
    expect(updated.version).toBe(2);
    expect(updated.title).toBe('Second draft');
    expect(updated.content).toBe('# Second draft');
  });

  it('keeps every past version internally', async () => {
    const created = await owner.publish({ type: 'markdown', content: '# One' });
    await update(created.id, { content: '# Two', baseVersion: 1 });
    await update(created.id, { content: '# Three', baseVersion: 2 });

    const service = server.database;
    const versions = service.raw
      .prepare('select version from artifact_versions where artifact_id = ? order by version')
      .all(created.id);
    expect(versions).toHaveLength(3);
  });

  it('rejects an update based on a version that is no longer current', async () => {
    const created = await owner.publish({ type: 'markdown', content: '# One' });
    await update(created.id, { content: '# Two', baseVersion: 1 });

    // A second agent still thinks the artifact is at version 1.
    const response = await update(created.id, { content: '# Also two', baseVersion: 1 });
    expect(response.status).toBe(409);

    const body = (await response.json()) as {
      error: { code: string; message: string; details: Record<string, number> };
    };
    expect(body.error.code).toBe('version_conflict');
    expect(body.error.details.currentVersion).toBe(2);
    expect(body.error.message).toContain('version 2');
  });

  it('leaves the stored content untouched when an update is rejected', async () => {
    const created = await owner.publish({ type: 'markdown', content: '# One' });
    await update(created.id, { content: '# Two', baseVersion: 1 });
    await update(created.id, { content: '# Clobbered', baseVersion: 1 });

    const response = await owner.as(`/api/artifacts/${created.id}`);
    expect(((await response.json()) as { content: string }).content).toBe('# Two');
  });

  it('requires baseVersion, so an update can never be accidentally unconditional', async () => {
    const created = await owner.publish({ type: 'markdown', content: '# One' });
    const response = await owner.as(`/api/artifacts/${created.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '# Two' }),
    });
    expect(await errorCode(response)).toBe('validation_failed');
  });

  it('re-derives the title when it was derived, and keeps it when it was chosen', async () => {
    const derived = await owner.publish({ type: 'markdown', content: '# Old heading' });
    const chosen = await owner.publish({
      type: 'markdown',
      content: '# Old heading',
      title: 'Chosen',
    });

    await update(derived.id, { content: '# New heading', baseVersion: 1 });
    await update(chosen.id, { content: '# New heading', baseVersion: 1 });

    expect(await titleOf(derived.id)).toBe('New heading');
    expect(await titleOf(chosen.id)).toBe('Chosen');
  });

  it('returns not_found when updating an artifact that does not exist', async () => {
    const response = await update('art_nope', { content: '# x', baseVersion: 1 });
    expect(response.status).toBe(404);
  });
});

describe('deleting an artifact', () => {
  it('deletes when the caller confirms', async () => {
    const created = await owner.publish({ type: 'markdown', content: '# Bye' });

    const response = await owner.as(`/api/artifacts/${created.id}?confirm=true`, {
      method: 'DELETE',
    });
    expect(response.status).toBe(204);
    expect((await owner.as(`/api/artifacts/${created.id}`)).status).toBe(404);
  });

  it('refuses to delete without the confirm flag', async () => {
    const created = await owner.publish({ type: 'markdown', content: '# Keep me' });

    const response = await owner.as(`/api/artifacts/${created.id}`, { method: 'DELETE' });
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe('validation_failed');
    expect((await owner.as(`/api/artifacts/${created.id}`)).status).toBe(200);
  });

  it('takes the version history with it, leaving no orphan rows', async () => {
    const created = await owner.publish({ type: 'markdown', content: '# One' });
    await update(created.id, { content: '# Two', baseVersion: 1 });
    await owner.as(`/api/artifacts/${created.id}?confirm=true`, { method: 'DELETE' });

    const remaining = server.database.raw
      .prepare('select count(*) as count from artifact_versions')
      .get() as { count: number };
    expect(remaining.count).toBe(0);
  });

  it('serves nothing at the artifact URL afterwards', async () => {
    const created = await owner.publish({ type: 'markdown', content: '# One' });
    await owner.as(`/api/artifacts/${created.id}?confirm=true`, { method: 'DELETE' });
    expect((await owner.as(`/a/${created.slug}`)).status).toBe(404);
  });
});

describe('health endpoint', () => {
  it('reports ok when the database answers', async () => {
    const response = await server.request('/healthz');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('reports unhealthy when the database has gone away', async () => {
    server.database.close();
    const response = await server.request('/healthz');
    expect(response.status).toBe(503);
    expect(((await response.json()) as { status: string }).status).toBe('error');
  });
});

describe('logging', () => {
  it('logs one line per request with method, path, status and how long it took', async () => {
    await server.request('/healthz');
    // Signing in during setup logs too, so look for this request specifically.
    const line = server.logLines.find(
      (entry) => entry.message === 'request' && entry.path === '/healthz',
    );
    expect(line).toMatchObject({ method: 'GET', path: '/healthz', status: 200 });
    expect(typeof line?.durationMs).toBe('number');
    expect(typeof line?.requestId).toBe('string');
  });

  it('stamps the same request id on the log line and the response header', async () => {
    const response = await server.request('/healthz');
    const header = response.headers.get('x-request-id');
    expect(header).toBeTruthy();
    expect(server.logLines.some((entry) => entry.requestId === header)).toBe(true);
  });

  it('logs unhandled errors with their request id and returns a safe message', async () => {
    // A fresh server, because a route can only be added before the first request.
    const crashing = createTestServer({ SIGNUP_MODE: 'open' });
    crashing.app.get('/boom', () => {
      throw new Error('database on fire');
    });

    const response = await crashing.request('/boom');
    expect(response.status).toBe(500);

    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('internal_error');
    // The reader gets no internals; the operator gets them in the log.
    expect(body.error.message).not.toContain('database on fire');

    const logged = crashing.logLines.find((entry) => entry.message === 'unhandled error');
    expect(logged?.error).toBe('database on fire');
    expect(typeof logged?.requestId).toBe('string');

    crashing.close();
  });
});

async function update(id: string, body: unknown): Promise<Response> {
  return owner.as(`/api/artifacts/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function titleOf(id: string): Promise<string> {
  const response = await owner.as(`/api/artifacts/${id}`);
  return ((await response.json()) as { title: string }).title;
}

async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code;
}
