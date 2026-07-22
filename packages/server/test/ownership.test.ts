import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTestServer,
  signIn,
  type TestServer,
  type SignedInUser,
  type PublishedArtifact,
} from './helpers/server.js';

/**
 * Artifacts are private to whoever published them.
 *
 * Ownership is checked against every endpoint that names an artifact, rather
 * than the one or two it would be easy to remember. Sharing has its own tests
 * in sharing.test.ts and access-matrix.test.ts.
 *
 * The refusal is always "no such artifact", never "not yours". Saying an artifact
 * exists but belongs to someone else confirms it exists, which is exactly what a
 * private artifact must not do.
 */

let server: TestServer;
let owner: SignedInUser;
let stranger: SignedInUser;
let artifact: PublishedArtifact;

beforeEach(async () => {
  server = createTestServer({ SIGNUP_MODE: 'open' });
  owner = await signIn(server, 'owner@example.com');
  stranger = await signIn(server, 'stranger@example.com');
  artifact = await owner.publish({ type: 'markdown', content: '# Private plans' });
});

afterEach(() => {
  server.close();
});

/** Every way of getting at one artifact. */
function endpoints(id: string, slug: string) {
  return [
    { name: 'read through the API', request: (as: Caller) => as(`/api/artifacts/${id}`) },
    {
      name: 'update',
      request: (as: Caller) =>
        as(`/api/artifacts/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: '# Changed', baseVersion: 1 }),
        }),
    },
    {
      name: 'delete',
      request: (as: Caller) => as(`/api/artifacts/${id}?confirm=true`, { method: 'DELETE' }),
    },
    { name: 'open the page', request: (as: Caller) => as(`/a/${slug}`) },
    { name: 'fetch the content', request: (as: Caller) => as(`/a/${slug}/content`) },
  ];
}

type Caller = (path: string, init?: RequestInit) => Promise<Response>;

const ENDPOINT_COUNT = endpoints('x', 'y').length;

describe('the owner', () => {
  it('can do everything with their own artifact', async () => {
    // One fresh artifact per endpoint, because one of the endpoints deletes it.
    for (let index = 0; index < ENDPOINT_COUNT; index += 1) {
      const own = await owner.publish({ type: 'markdown', content: '# Mine' });
      const endpoint = endpoints(own.id, own.slug)[index]!;

      const response = await endpoint.request(owner.as);
      expect(response.status, `owner should be able to ${endpoint.name}`).toBeLessThan(400);
    }
  });

  it('is recorded as the owner on the artifact', async () => {
    expect(artifact.ownerId).toBe(owner.id);
  });
});

describe('somebody else who is signed in', () => {
  it('is told the artifact does not exist, at every endpoint', async () => {
    for (const endpoint of endpoints(artifact.id, artifact.slug)) {
      const response = await endpoint.request(stranger.as);
      expect(response.status, `stranger should not be able to ${endpoint.name}`).toBe(404);
    }
  });

  it('gets the same answer for a real artifact and an invented id', async () => {
    const real = await stranger.as(`/api/artifacts/${artifact.id}`);
    const invented = await stranger.as('/api/artifacts/art_never_existed');

    expect(real.status).toBe(invented.status);
    expect(await real.json()).toEqual(await invented.json());
  });

  it('cannot change the artifact even by guessing its version', async () => {
    await stranger.as(`/api/artifacts/${artifact.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '# Vandalised', baseVersion: 1 }),
    });

    const response = await owner.as(`/api/artifacts/${artifact.id}`);
    expect(((await response.json()) as { content: string }).content).toBe('# Private plans');
  });

  it('does not see it in their own list', async () => {
    const response = await stranger.as('/api/artifacts');
    expect(((await response.json()) as { artifacts: unknown[] }).artifacts).toHaveLength(0);
  });
});

describe('nobody signed in at all', () => {
  it('cannot read an artifact', async () => {
    for (const endpoint of endpoints(artifact.id, artifact.slug)) {
      const response = await endpoint.request((path, init) =>
        server.request(path, { ...init, redirect: 'manual' }),
      );

      // Either refused outright, or sent to sign in first. What must never
      // happen is the artifact coming back.
      expect(response.status, `anonymous should not be able to ${endpoint.name}`).not.toBeLessThan(
        300,
      );
      expect(await response.text(), endpoint.name).not.toContain('Private plans');
    }
  });

  it('cannot publish', async () => {
    const response = await server.request('/api/artifacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'markdown', content: '# Anonymous' }),
    });
    expect(response.status).toBe(401);
  });

  it('is told how to sign in rather than just refused', async () => {
    const response = await server.request('/api/artifacts');
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain('open-artifact login');
  });
});

describe('the list of my artifacts', () => {
  it('holds mine and nobody else’s', async () => {
    await stranger.publish({ type: 'markdown', content: '# Their own work' });
    await owner.publish({ type: 'markdown', content: '# My second' });

    const mine = (await (await owner.as('/api/artifacts')).json()) as {
      artifacts: { title: string }[];
    };
    expect(mine.artifacts.map((entry) => entry.title).sort()).toEqual([
      'My second',
      'Private plans',
    ]);
  });
});

describe('deleting an account', () => {
  it('takes that person’s artifacts and version history with it', async () => {
    // Enforced by a database trigger, because SQLite would not accept the foreign
    // key on this column. Worth testing directly for exactly that reason.
    server.database.raw.prepare('delete from users where id = ?').run(owner.id);

    const remainingArtifacts = server.database.raw
      .prepare('select count(*) as count from artifacts')
      .get() as { count: number };
    const remainingVersions = server.database.raw
      .prepare('select count(*) as count from artifact_versions')
      .get() as { count: number };

    expect(remainingArtifacts.count).toBe(0);
    expect(remainingVersions.count).toBe(0);
  });
});
