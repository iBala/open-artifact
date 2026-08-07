import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTestServer,
  signIn,
  jsonBody,
  type TestServer,
  type SignedInUser,
  type PublishedArtifact,
} from './helpers/server.js';

/**
 * Links that stop working.
 *
 * An artifact has one deadline. It applies to everybody except the owner, it is
 * stamped the first time the artifact is shared with anybody, and making the
 * artifact public brings it in to a week.
 *
 * The guarantees worth holding onto are at the bottom: an expired link never
 * tells a stranger that an artifact exists, and saying yes to somebody asking
 * for it back actually gives it back.
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

/** The deadline as the owner's sharing panel sees it. */
async function expiryOf(artifactId: string): Promise<string | null> {
  const body = (await (await owner.as(`/api/artifacts/${artifactId}/sharing`)).json()) as {
    expiresAt: string | null;
  };
  return body.expiresAt;
}

/** Winds the clock forward by rewriting the stored deadline, the way time would. */
function expireNow(artifactId: string): void {
  server.database.raw
    .prepare('update artifacts set expires_at = ? where id = ?')
    .run('2020-01-01T00:00:00.000Z', artifactId);
}

/** Roughly how many days from now a deadline is. */
function daysAway(iso: string | null): number {
  if (iso === null) throw new Error('expected a deadline, got forever');
  return (new Date(iso).getTime() - Date.now()) / 86_400_000;
}

async function shareWith(artifact: PublishedArtifact, email: string): Promise<void> {
  const response = await owner.as(
    `/api/artifacts/${artifact.id}/sharing/people`,
    jsonBody({ email }),
  );
  if (!response.ok) throw new Error(`share failed: ${await response.text()}`);
}

describe('the default deadline', () => {
  it('is not set on an artifact nobody else can reach', async () => {
    const artifact = await owner.publish({ type: 'markdown', content: '# Draft' });

    // Nothing to expire yet. A clock started here would already have run down
    // by the time somebody shared it three months later.
    expect(await expiryOf(artifact.id)).toBeNull();
  });

  /**
   * Present and null, not absent. A client cannot tell "never expires" from "this
   * server is too old to know about expiry" if the field simply is not there.
   */
  it('is reported on every artifact response, including a brand new one', async () => {
    const artifact = await owner.publish({ type: 'markdown', content: '# Draft' });

    const created = (await (await owner.as(`/api/artifacts/${artifact.id}`)).json()) as Record<
      string,
      unknown
    >;
    expect(created).toHaveProperty('expiresAt', null);

    const listed = (await (await owner.as('/api/artifacts')).json()) as {
      artifacts: Record<string, unknown>[];
    };
    expect(listed.artifacts[0]).toHaveProperty('expiresAt', null);
  });

  it('is 90 days, stamped when the artifact is first shared with somebody', async () => {
    const artifact = await owner.publish({ type: 'markdown', content: '# Report' });
    await shareWith(artifact, 'reader@example.com');

    expect(daysAway(await expiryOf(artifact.id))).toBeCloseTo(90, 1);
  });

  it('is 90 days when the first share is with a whole domain', async () => {
    const artifact = await owner.publish({ type: 'markdown', content: '# Report' });
    await owner.as(`/api/artifacts/${artifact.id}/sharing/domains`, jsonBody({ domain: 'zorp.one' }));

    expect(daysAway(await expiryOf(artifact.id))).toBeCloseTo(90, 1);
  });

  it('is 7 days when the artifact is made public', async () => {
    const artifact = await owner.publish({ type: 'markdown', content: '# Announcement' });
    await owner.as(
      `/api/artifacts/${artifact.id}/sharing/public`,
      { ...jsonBody({ isPublic: true }), method: 'PUT' },
    );

    expect(daysAway(await expiryOf(artifact.id))).toBeCloseTo(7, 1);
  });

  it('is not re-stamped when a second person is added', async () => {
    const artifact = await owner.publish({ type: 'markdown', content: '# Report' });
    await shareWith(artifact, 'reader@example.com');

    // The owner deliberately shortens it, then adds somebody else. Adding a
    // name must not quietly hand back the 90 days they just took away.
    await owner.as(
      `/api/artifacts/${artifact.id}/sharing/expiry`,
      { ...jsonBody({ expiresIn: '24h' }), method: 'PUT' },
    );
    await shareWith(artifact, 'third@example.com');

    expect(daysAway(await expiryOf(artifact.id))).toBeCloseTo(1, 1);
  });

  it('does not overwrite a deadline the owner set before sharing with anybody', async () => {
    const artifact = await owner.publish({ type: 'markdown', content: '# Report' });

    // Nothing is shared yet, so the first-grant stamp has not fired. Setting a
    // deadline now and then sharing must keep the deadline, not replace it with
    // the 90-day default.
    await owner.as(
      `/api/artifacts/${artifact.id}/sharing/expiry`,
      { ...jsonBody({ expiresIn: '3d' }), method: 'PUT' },
    );
    await shareWith(artifact, 'reader@example.com');

    expect(daysAway(await expiryOf(artifact.id))).toBeCloseTo(3, 1);
  });

  it('leaves an artifact that was already shared before this feature existed alone', async () => {
    const artifact = await owner.publish({ type: 'markdown', content: '# Old' });
    await shareWith(artifact, 'reader@example.com');

    // Exactly the state the migration leaves every existing artifact in: shared,
    // with no deadline. It means forever, and adding another person must not
    // read it as "nobody has set one yet" and start a clock.
    server.database.raw
      .prepare('update artifacts set expires_at = null where id = ?')
      .run(artifact.id);

    await shareWith(artifact, 'third@example.com');
    expect(await expiryOf(artifact.id)).toBeNull();
  });
});

describe('making an artifact public', () => {
  it('shortens a longer deadline to a week', async () => {
    const artifact = await owner.publish({ type: 'markdown', content: '# Report' });
    await shareWith(artifact, 'reader@example.com');
    expect(daysAway(await expiryOf(artifact.id))).toBeCloseTo(90, 1);

    await owner.as(
      `/api/artifacts/${artifact.id}/sharing/public`,
      { ...jsonBody({ isPublic: true }), method: 'PUT' },
    );
    expect(daysAway(await expiryOf(artifact.id))).toBeCloseTo(7, 1);
  });

  it('never lengthens one that is already shorter', async () => {
    const artifact = await owner.publish({ type: 'markdown', content: '# Report' });
    await shareWith(artifact, 'reader@example.com');
    await owner.as(
      `/api/artifacts/${artifact.id}/sharing/expiry`,
      { ...jsonBody({ expiresIn: '2h' }), method: 'PUT' },
    );

    await owner.as(
      `/api/artifacts/${artifact.id}/sharing/public`,
      { ...jsonBody({ isPublic: true }), method: 'PUT' },
    );

    // Somebody who set two hours and then made it public meant the two hours.
    expect(daysAway(await expiryOf(artifact.id))).toBeCloseTo(2 / 24, 2);
  });

  it('can still be set back to forever, because the week is a default and not a cap', async () => {
    const artifact = await owner.publish({ type: 'markdown', content: '# Permanent page' });
    await owner.as(
      `/api/artifacts/${artifact.id}/sharing/public`,
      { ...jsonBody({ isPublic: true }), method: 'PUT' },
    );

    const response = await owner.as(
      `/api/artifacts/${artifact.id}/sharing/expiry`,
      { ...jsonBody({ expiresIn: 'forever' }), method: 'PUT' },
    );

    expect(response.status).toBe(200);
    expect(await expiryOf(artifact.id)).toBeNull();
  });
});

describe('setting the deadline', () => {
  it('takes hours and days, and counts from the server clock', async () => {
    const artifact = await owner.publish({ type: 'markdown', content: '# Report' });

    for (const [spec, days] of [
      ['1h', 1 / 24],
      ['36h', 1.5],
      ['7d', 7],
      ['30 days', 30],
    ] as const) {
      const response = await owner.as(
        `/api/artifacts/${artifact.id}/sharing/expiry`,
        { ...jsonBody({ expiresIn: spec }), method: 'PUT' },
      );
      expect(response.status, spec).toBe(200);
      expect(daysAway(await expiryOf(artifact.id)), spec).toBeCloseTo(days, 1);
    }
  });

  it('refuses a bare number, rather than guessing hours or days', async () => {
    const artifact = await owner.publish({ type: 'markdown', content: '# Report' });
    const response = await owner.as(
      `/api/artifacts/${artifact.id}/sharing/expiry`,
      { ...jsonBody({ expiresIn: '7' }), method: 'PUT' },
    );

    expect(response.status).toBe(400);
  });

  it('is something only the owner can do', async () => {
    const artifact = await owner.publish({ type: 'markdown', content: '# Report' });
    await shareWith(artifact, 'reader@example.com');

    const response = await reader.as(
      `/api/artifacts/${artifact.id}/sharing/expiry`,
      { ...jsonBody({ expiresIn: 'forever' }), method: 'PUT' },
    );

    // Not 403: being told it exists but is not yours confirms it exists.
    expect(response.status).toBe(404);
  });
});

describe('once the deadline has passed', () => {
  it('turns the reader away from the artifact and its content', async () => {
    const artifact = await owner.publish({ type: 'markdown', content: '# Report' });
    await shareWith(artifact, 'reader@example.com');
    expireNow(artifact.id);

    const meta = await reader.as(`/api/artifacts/by-slug/${artifact.slug}`);
    expect(meta.status).toBe(410);

    // The bytes are behind their own check, not just the page around them.
    const content = await reader.as(`/a/${artifact.slug}/content`);
    expect(content.status).toBe(410);
  });

  it('says so, with enough to render the page that explains it', async () => {
    const artifact = await owner.publish({ type: 'markdown', content: '# Report', title: 'Q3 plan' });
    await shareWith(artifact, 'reader@example.com');
    expireNow(artifact.id);

    const body = (await (await reader.as(`/api/artifacts/by-slug/${artifact.slug}`)).json()) as {
      error: { code: string; details: Record<string, unknown> };
    };

    expect(body.error.code).toBe('gone');
    expect(body.error.details).toMatchObject({
      title: 'Q3 plan',
      ownerEmail: 'owner@example.com',
      canRequestAccess: true,
    });
  });

  /**
   * 410 is cacheable by default, and so is 404.
   *
   * Without this, a browser that once saw "this link has expired" can go on
   * showing it after the owner has turned the link back on. The person presses
   * "ask for access again", the owner says yes, and nothing changes for them —
   * which reads as the feature being broken rather than as a cached response.
   */
  it('is never stored by a cache, so restoring the link is visible immediately', async () => {
    const artifact = await owner.publish({ type: 'markdown', content: '# Report' });
    await shareWith(artifact, 'reader@example.com');
    expireNow(artifact.id);

    const refused = await reader.as(`/api/artifacts/by-slug/${artifact.slug}`);
    expect(refused.status).toBe(410);
    expect(refused.headers.get('cache-control')).toContain('no-store');

    // And the same for the plain "not yours", which is cacheable too.
    const stranger = await signIn(server, 'stranger@elsewhere.test');
    const missing = await stranger.as(`/api/artifacts/by-slug/${artifact.slug}`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get('cache-control')).toContain('no-store');
  });

  it('leaves the owner untouched', async () => {
    const artifact = await owner.publish({ type: 'markdown', content: '# Report' });
    await shareWith(artifact, 'reader@example.com');
    expireNow(artifact.id);

    expect((await owner.as(`/api/artifacts/by-slug/${artifact.slug}`)).status).toBe(200);
    expect((await owner.as(`/a/${artifact.slug}/content`)).status).toBe(200);

    // And can still set a new deadline, which is the way back.
    const revived = await owner.as(
      `/api/artifacts/${artifact.id}/sharing/expiry`,
      { ...jsonBody({ expiresIn: '30d' }), method: 'PUT' },
    );
    expect(revived.status).toBe(200);
    expect((await reader.as(`/api/artifacts/by-slug/${artifact.slug}`)).status).toBe(200);
  });

  it('closes a public link to the signed-out world', async () => {
    const artifact = await owner.publish({ type: 'markdown', content: '# Announcement' });
    await owner.as(
      `/api/artifacts/${artifact.id}/sharing/public`,
      { ...jsonBody({ isPublic: true }), method: 'PUT' },
    );

    expect((await server.request(`/a/${artifact.slug}/content`)).status).toBe(200);
    expireNow(artifact.id);
    expect((await server.request(`/a/${artifact.slug}/content`)).status).toBe(410);
  });

  it('drops off the list of artifacts shared with me', async () => {
    const artifact = await owner.publish({ type: 'markdown', content: '# Report' });
    await shareWith(artifact, 'reader@example.com');

    const before = (await (await reader.as('/api/shared-with-me')).json()) as {
      artifacts: { id: string }[];
    };
    expect(before.artifacts.map((a) => a.id)).toContain(artifact.id);

    expireNow(artifact.id);

    const after = (await (await reader.as('/api/shared-with-me')).json()) as {
      artifacts: { id: string }[];
    };
    expect(after.artifacts.map((a) => a.id)).not.toContain(artifact.id);
  });
});

/**
 * The disclosure rule.
 *
 * "This link expired" is a friendlier answer than "no such artifact", and it is
 * only ever the right answer for somebody the link actually worked for. If it
 * leaked past them, an expired private artifact would become a way to confirm
 * that an id or a slug is real by asking about it.
 */
describe('what an expired link tells a stranger', () => {
  it('tells them nothing: they get the same answer as for an artifact that does not exist', async () => {
    const artifact = await owner.publish({ type: 'markdown', content: '# Private' });
    await shareWith(artifact, 'reader@example.com');
    expireNow(artifact.id);

    const stranger = await signIn(server, 'stranger@elsewhere.test');

    const real = await stranger.as(`/api/artifacts/by-slug/${artifact.slug}`);
    const invented = await stranger.as('/api/artifacts/by-slug/gg7mkq2xw9prahd4vcnfujte');

    expect(real.status).toBe(404);
    expect(real.status).toBe(invented.status);
    expect(await real.text()).toBe(await invented.text());
  });

  it('tells a signed-out reader of a never-public artifact nothing either', async () => {
    const artifact = await owner.publish({ type: 'markdown', content: '# Private' });
    await shareWith(artifact, 'reader@example.com');
    expireNow(artifact.id);

    expect((await server.request(`/a/${artifact.slug}/content`)).status).toBe(404);
  });
});

/**
 * Sharing something whose link has already died.
 *
 * Every one of these is the owner granting access, and granting access has to
 * mean the link works. The failure mode without it is quiet and nasty: the
 * share succeeds, the recipient is emailed, and they land on "this link has
 * expired" — so it reads as the share having failed, and nothing in front of
 * the owner points at the clock.
 */
describe('resharing an expired artifact', () => {
  it('brings the link back when a new person is added', async () => {
    const artifact = await owner.publish({ type: 'markdown', content: '# Report' });
    await shareWith(artifact, 'reader@example.com');
    expireNow(artifact.id);

    await shareWith(artifact, 'newcomer@example.com');

    const newcomer = await signIn(server, 'newcomer@example.com');
    expect((await newcomer.as(`/api/artifacts/by-slug/${artifact.slug}`)).status).toBe(200);
    expect(daysAway(await expiryOf(artifact.id))).toBeCloseTo(90, 1);

    // And the person who was already on the list gets back in too: there is one
    // clock, so reviving it revives it for everybody.
    expect((await reader.as(`/api/artifacts/by-slug/${artifact.slug}`)).status).toBe(200);
  });

  it('brings it back when a whole domain is added', async () => {
    const artifact = await owner.publish({ type: 'markdown', content: '# Report' });
    await shareWith(artifact, 'reader@example.com');
    expireNow(artifact.id);

    await owner.as(`/api/artifacts/${artifact.id}/sharing/domains`, jsonBody({ domain: 'zorp.one' }));

    const colleague = await signIn(server, 'colleague@zorp.one');
    expect((await colleague.as(`/api/artifacts/by-slug/${artifact.slug}`)).status).toBe(200);
  });

  it('brings it back when the artifact is made public, at the public default', async () => {
    const artifact = await owner.publish({ type: 'markdown', content: '# Announcement' });
    await shareWith(artifact, 'reader@example.com');
    expireNow(artifact.id);

    await owner.as(
      `/api/artifacts/${artifact.id}/sharing/public`,
      { ...jsonBody({ isPublic: true }), method: 'PUT' },
    );

    expect((await server.request(`/a/${artifact.slug}/content`)).status).toBe(200);
    expect(daysAway(await expiryOf(artifact.id))).toBeCloseTo(7, 1);
  });

  it('brings it back on the first share, even if the deadline was set and left to lapse', async () => {
    const artifact = await owner.publish({ type: 'markdown', content: '# Report' });
    await owner.as(
      `/api/artifacts/${artifact.id}/sharing/expiry`,
      { ...jsonBody({ expiresIn: '1h' }), method: 'PUT' },
    );
    expireNow(artifact.id);

    await shareWith(artifact, 'reader@example.com');
    expect((await reader.as(`/api/artifacts/by-slug/${artifact.slug}`)).status).toBe(200);
  });

  it('still does not lengthen a deadline that is merely short but alive', async () => {
    const artifact = await owner.publish({ type: 'markdown', content: '# Report' });
    await shareWith(artifact, 'reader@example.com');
    await owner.as(
      `/api/artifacts/${artifact.id}/sharing/expiry`,
      { ...jsonBody({ expiresIn: '2h' }), method: 'PUT' },
    );

    // Reviving is only ever for a link that is already dead. A live two hours
    // must survive both another share and being made public.
    await shareWith(artifact, 'third@example.com');
    await owner.as(
      `/api/artifacts/${artifact.id}/sharing/public`,
      { ...jsonBody({ isPublic: true }), method: 'PUT' },
    );

    expect(daysAway(await expiryOf(artifact.id))).toBeCloseTo(2 / 24, 2);
  });
});

describe('asking for an expired link back', () => {
  it('puts a request in front of the owner, once however often it is asked', async () => {
    const artifact = await owner.publish({ type: 'markdown', content: '# Report' });
    await shareWith(artifact, 'reader@example.com');
    expireNow(artifact.id);

    const first = await reader.as(
      `/api/artifacts/by-slug/${artifact.slug}/access-request`,
      { method: 'POST' },
    );
    expect(first.status).toBe(200);
    expect((await first.json()) as { alreadyPending: boolean }).toMatchObject({
      alreadyPending: false,
    });

    const again = await reader.as(
      `/api/artifacts/by-slug/${artifact.slug}/access-request`,
      { method: 'POST' },
    );
    expect((await again.json()) as { alreadyPending: boolean }).toMatchObject({
      alreadyPending: true,
    });

    const waiting = (await (await owner.as('/api/access-requests')).json()) as {
      requests: { id: string; email: string }[];
    };
    expect(waiting.requests).toHaveLength(1);
    expect(waiting.requests[0]?.email).toBe('reader@example.com');
  });

  it('is refused for somebody the link never worked for', async () => {
    const artifact = await owner.publish({ type: 'markdown', content: '# Private' });
    await shareWith(artifact, 'reader@example.com');
    expireNow(artifact.id);

    const stranger = await signIn(server, 'stranger@elsewhere.test');
    const response = await stranger.as(
      `/api/artifacts/by-slug/${artifact.slug}/access-request`,
      { method: 'POST' },
    );

    // Otherwise anybody could fill an owner's bell with requests for artifacts
    // they were never given, and learn which slugs are real while doing it.
    expect(response.status).toBe(404);
    expect(
      ((await (await owner.as('/api/access-requests')).json()) as { requests: unknown[] }).requests,
    ).toHaveLength(0);
  });

  it('actually gives the link back when the owner says yes', async () => {
    const artifact = await owner.publish({ type: 'markdown', content: '# Report' });
    await shareWith(artifact, 'reader@example.com');
    expireNow(artifact.id);

    await reader.as(`/api/artifacts/by-slug/${artifact.slug}/access-request`, { method: 'POST' });
    const waiting = (await (await owner.as('/api/access-requests')).json()) as {
      requests: { id: string }[];
    };

    await owner.as(
      `/api/access-requests/${waiting.requests[0]?.id}/decide`,
      jsonBody({ grant: true }),
    );

    // A share row behind a deadline that has already passed is still a closed
    // door. Saying yes has to move the deadline too.
    expect((await reader.as(`/api/artifacts/by-slug/${artifact.slug}`)).status).toBe(200);
    expect(daysAway(await expiryOf(artifact.id))).toBeCloseTo(90, 1);
  });

  it('does not move a deadline that is still in the future', async () => {
    const artifact = await owner.publish({ type: 'markdown', content: '# Report' });
    await shareWith(artifact, 'reader@example.com');
    await owner.as(
      `/api/artifacts/${artifact.id}/sharing/expiry`,
      { ...jsonBody({ expiresIn: '2d' }), method: 'PUT' },
    );

    // A mention-driven request from somebody else, granted while the link works.
    const outsider = await signIn(server, 'outsider@elsewhere.test');
    void outsider;
    await owner.as(
      `/api/artifacts/${artifact.id}/sharing/people`,
      jsonBody({ email: 'outsider@elsewhere.test' }),
    );

    // Letting one more person in is not a reason to extend everybody's access.
    expect(daysAway(await expiryOf(artifact.id))).toBeCloseTo(2, 1);
  });
});
