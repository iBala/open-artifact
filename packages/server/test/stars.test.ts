import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestServer, signIn, jsonBody, type TestServer, type SignedInUser } from './helpers/server.js';

/**
 * Starring: one person's private bookmark on an artifact.
 *
 * The guarantees here are that a star grants nothing, that it is idempotent in
 * both directions, that it is private to the person who set it, and that it
 * follows the artifact into the two listings a signed-in person reads.
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

/** What the by-slug read (the one the viewer's page loads) reports for this person. */
async function starredFlag(user: SignedInUser, slug: string): Promise<boolean | undefined> {
  const body = (await (await user.as(`/api/artifacts/by-slug/${slug}`)).json()) as {
    starred?: boolean;
  };
  return body.starred;
}

describe('starring your own artifact', () => {
  it('toggles on with PUT and off with DELETE, idempotently', async () => {
    const artifact = await owner.publish({ type: 'markdown', content: '# Report' });

    const on = await owner.as(`/api/artifacts/${artifact.id}/star`, { method: 'PUT' });
    expect(on.status).toBe(200);
    expect((await on.json()) as { starred: boolean }).toEqual({ starred: true });

    // Starring again is still a success and leaves exactly one row.
    await owner.as(`/api/artifacts/${artifact.id}/star`, { method: 'PUT' });
    const rows = server.database.raw
      .prepare('select count(*) as count from artifact_stars where artifact_id = ?')
      .get(artifact.id) as { count: number };
    expect(rows.count).toBe(1);

    const off = await owner.as(`/api/artifacts/${artifact.id}/star`, { method: 'DELETE' });
    expect((await off.json()) as { starred: boolean }).toEqual({ starred: false });

    // Unstarring what is not starred is fine.
    const offAgain = await owner.as(`/api/artifacts/${artifact.id}/star`, { method: 'DELETE' });
    expect(offAgain.status).toBe(200);
  });

  it('shows the star on the list of your artifacts', async () => {
    const one = await owner.publish({ type: 'markdown', content: '# One' });
    const two = await owner.publish({ type: 'markdown', content: '# Two' });
    await owner.as(`/api/artifacts/${one.id}/star`, { method: 'PUT' });

    const list = (await (await owner.as('/api/artifacts')).json()) as {
      artifacts: { id: string; starred: boolean }[];
    };
    const byId = new Map(list.artifacts.map((a) => [a.id, a.starred]));
    expect(byId.get(one.id)).toBe(true);
    expect(byId.get(two.id)).toBe(false);
  });

  it('reports the star on the by-slug read the viewer loads', async () => {
    const artifact = await owner.publish({ type: 'markdown', content: '# Report' });
    expect(await starredFlag(owner, artifact.slug)).toBe(false);
    await owner.as(`/api/artifacts/${artifact.id}/star`, { method: 'PUT' });
    expect(await starredFlag(owner, artifact.slug)).toBe(true);
  });
});

describe('a star is private and grants nothing', () => {
  it('lets you star an artifact shared with you, and shows it on shared-with-me', async () => {
    const reader = await signIn(server, 'reader@example.com');
    const artifact = await owner.publish({ type: 'markdown', content: '# Shared' });
    await owner.as(`/api/artifacts/${artifact.id}/sharing/people`, jsonBody({ email: 'reader@example.com' }));

    const star = await reader.as(`/api/artifacts/${artifact.id}/star`, { method: 'PUT' });
    expect(star.status).toBe(200);

    const shared = (await (await reader.as('/api/shared-with-me')).json()) as {
      artifacts: { id: string; starred: boolean }[];
    };
    expect(shared.artifacts.find((a) => a.id === artifact.id)?.starred).toBe(true);
  });

  it('keeps one person’s star invisible to another', async () => {
    const reader = await signIn(server, 'reader@example.com');
    const artifact = await owner.publish({ type: 'markdown', content: '# Shared' });
    await owner.as(`/api/artifacts/${artifact.id}/sharing/people`, jsonBody({ email: 'reader@example.com' }));

    // The reader stars it; the owner did not.
    await reader.as(`/api/artifacts/${artifact.id}/star`, { method: 'PUT' });

    expect(await starredFlag(reader, artifact.slug)).toBe(true);
    expect(await starredFlag(owner, artifact.slug)).toBe(false);
  });

  it('refuses to star an artifact you cannot see', async () => {
    const stranger = await signIn(server, 'stranger@example.com');
    const artifact = await owner.publish({ type: 'markdown', content: '# Private' });

    const response = await stranger.as(`/api/artifacts/${artifact.id}/star`, { method: 'PUT' });
    expect(response.status).toBe(404);
  });

  it('needs a signed-in caller', async () => {
    const artifact = await owner.publish({ type: 'markdown', content: '# Report' });
    const response = await server.request(`/api/artifacts/${artifact.id}/star`, { method: 'PUT' });
    expect(response.status).toBe(401);
  });
});

describe('a star does not outlive its artifact', () => {
  it('is removed when the artifact is deleted, leaving no orphan row', async () => {
    const artifact = await owner.publish({ type: 'markdown', content: '# Report' });
    await owner.as(`/api/artifacts/${artifact.id}/star`, { method: 'PUT' });

    await owner.as(`/api/artifacts/${artifact.id}?confirm=true`, { method: 'DELETE' });

    const rows = server.database.raw
      .prepare('select count(*) as count from artifact_stars')
      .get() as { count: number };
    expect(rows.count).toBe(0);
  });
});
