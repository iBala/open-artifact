import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTestServer,
  signIn,
  jsonBody,
  signInCodeFor,
  type TestServer,
  type SignedInUser,
  type PublishedArtifact,
} from './helpers/server.js';

/**
 * Sharing with somebody who has never been here.
 *
 * This is the common case, not the edge case: the whole point of sharing by
 * email address is that you do not have to ask whether they have an account
 * first. The invitation waits, and attaches the moment they prove they own the
 * address.
 *
 * "Prove" is doing real work in that sentence. Attaching on an unverified
 * address would let anybody claim whatever had been shared with somebody else's.
 */

let server: TestServer;
let owner: SignedInUser;
let artifact: PublishedArtifact;

beforeEach(async () => {
  server = createTestServer({ SIGNUP_MODE: 'open' });
  owner = await signIn(server, 'owner@example.com');
  artifact = await owner.publish({ type: 'markdown', content: '# Quarterly report' });
});

afterEach(() => {
  server.close();
});

const shareWith = (email: string) =>
  owner.as(`/api/artifacts/${artifact.id}/sharing/people`, jsonBody({ email }));

async function sharingState(): Promise<{ people: { email: string; pending: boolean }[] }> {
  return (await (await owner.as(`/api/artifacts/${artifact.id}/sharing`)).json()) as never;
}

describe('sharing with somebody who has no account', () => {
  it('is allowed, and shows as waiting for them', async () => {
    await shareWith('newcomer@example.com');

    const state = await sharingState();
    expect(state.people[0]).toMatchObject({ email: 'newcomer@example.com', pending: true });
  });

  it('gives them the artifact the moment they sign in', async () => {
    await shareWith('newcomer@example.com');

    const newcomer = await signIn(server, 'newcomer@example.com');
    expect((await newcomer.as(`/api/artifacts/${artifact.id}`)).status).toBe(200);
  });

  it('stops showing as waiting once they have signed in', async () => {
    await shareWith('newcomer@example.com');
    await signIn(server, 'newcomer@example.com');

    expect((await sharingState()).people[0]?.pending).toBe(false);
  });

  it('puts it in their shared-with-me list on their first visit', async () => {
    await shareWith('newcomer@example.com');
    const newcomer = await signIn(server, 'newcomer@example.com');

    const body = (await (await newcomer.as('/api/shared-with-me')).json()) as {
      artifacts: { title: string }[];
    };
    expect(body.artifacts.map((entry) => entry.title)).toEqual(['Quarterly report']);
  });

  it('works when they sign in with Google rather than an email link', async () => {
    const withGoogle = createTestServer({
      SIGNUP_MODE: 'open',
      GOOGLE_CLIENT_ID: 'id.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'secret',
    });

    try {
      const publisher = await signIn(withGoogle, 'publisher@example.com');
      const shared = await publisher.publish({ type: 'markdown', content: '# For the newcomer' });
      const sharedResponse = await publisher.as(`/api/artifacts/${shared.id}/sharing/people`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'newcomer@example.com' }),
      });
      expect(sharedResponse.status, await sharedResponse.clone().text()).toBe(201);

      // Sign in with Google, carrying the same verified address.
      const start = await withGoogle.request('/auth/google/start', { redirect: 'manual' });
      const state = new URL(start.headers.get('location') ?? '').searchParams.get('state') ?? '';
      withGoogle.google.nextIdentity = {
        email: 'newcomer@example.com',
        emailVerified: true,
        displayName: 'New Comer',
      };

      const callback = await withGoogle.request(`/auth/google/callback?state=${state}&code=x`, {
        redirect: 'manual',
        headers: { Cookie: `oa_google_state=${state}` },
      });
      expect(callback.status, await callback.clone().text()).toBe(302);

      // The callback sets two cookies: it clears the sign-in state and sets the
      // session. Take the session one by name rather than by position.
      const cookie =
        callback.headers
          .getSetCookie()
          .map((header) => header.split(';')[0] ?? '')
          .find((pair) => pair.startsWith('oa_session=')) ?? '';
      expect(cookie).not.toBe('');

      const response = await withGoogle.request(`/api/artifacts/${shared.id}`, {
        headers: { Cookie: cookie },
      });
      expect(response.status).toBe(200);
    } finally {
      withGoogle.close();
    }
  });

  it('gives nothing to somebody who signs in with a different address', async () => {
    await shareWith('newcomer@example.com');

    const someoneElse = await signIn(server, 'different@example.com');
    expect((await someoneElse.as(`/api/artifacts/${artifact.id}`)).status).toBe(404);

    const body = (await (await someoneElse.as('/api/shared-with-me')).json()) as {
      artifacts: unknown[];
    };
    expect(body.artifacts).toHaveLength(0);
  });

  it('attaches everything waiting for them, not just the first one', async () => {
    const second = await owner.publish({ type: 'markdown', content: '# Another one' });
    await shareWith('newcomer@example.com');
    await owner.as(`/api/artifacts/${second.id}/sharing/people`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'newcomer@example.com' }),
    });

    const newcomer = await signIn(server, 'newcomer@example.com');
    const body = (await (await newcomer.as('/api/shared-with-me')).json()) as {
      artifacts: unknown[];
    };
    expect(body.artifacts).toHaveLength(2);
  });

  it('attaches something shared after they had already signed in', async () => {
    // They signed in last week; the artifact is shared today. Nothing about
    // their next visit should be special, and the share should already be theirs.
    const newcomer = await signIn(server, 'newcomer@example.com');
    await shareWith('newcomer@example.com');

    expect((await newcomer.as(`/api/artifacts/${artifact.id}`)).status).toBe(200);
    expect((await sharingState()).people[0]?.pending).toBe(false);
  });
});

describe('an invitation on an invite-only instance', () => {
  /**
   * The two rules meeting: an instance nobody can join, and an invitation
   * addressed to somebody who is not a member yet. Being shared something is
   * what an invitation is.
   */
  it('is what lets somebody in', async () => {
    const closed = createTestServer({ SIGNUP_MODE: 'invite-only' });

    try {
      // The first account is always allowed, so the instance is usable at all.
      const publisher = await signIn(closed, 'founder@example.com');
      const shared = await publisher.publish({ type: 'markdown', content: '# For a colleague' });

      // Somebody with no invitation is turned away.
      await closed.request('/api/auth/code', jsonBody({ email: 'stranger@example.com' }));
      const turnedAway = await closed.request(
        '/api/auth/verify-code',
        jsonBody({ email: 'stranger@example.com', code: signInCodeFor(closed, 'stranger@example.com') }),
      );
      expect(turnedAway.status).toBe(403);

      // Sharing with them is the invitation.
      await publisher.as(`/api/artifacts/${shared.id}/sharing/people`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'stranger@example.com' }),
      });

      closed.mailer.clear();
      await closed.request('/api/auth/code', jsonBody({ email: 'stranger@example.com' }));
      const letIn = await closed.request(
        '/api/auth/verify-code',
        jsonBody({ email: 'stranger@example.com', code: signInCodeFor(closed, 'stranger@example.com') }),
      );
      expect(letIn.status).toBe(200);

      // And the artifact is waiting for them.
      const cookie = (letIn.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
      const response = await closed.request(`/api/artifacts/${shared.id}`, {
        headers: { Cookie: cookie },
      });
      expect(response.status).toBe(200);
    } finally {
      closed.close();
    }
  });
});

describe('what an unverified address gets', () => {
  it('nothing, even when an artifact is shared with exactly that address', async () => {
    await shareWith('newcomer@example.com');

    // An account exists for that address but nobody has proved they own it.
    // Attaching here would let anybody claim somebody else's invitations.
    const timestamp = '2026-07-22T00:00:00.000Z';
    server.database.raw
      .prepare(
        'insert into users (id, email, display_name, email_verified, created_at, updated_at) values (?, ?, ?, 0, ?, ?)',
      )
      .run('usr_unverified', 'unverified@example.com', null, timestamp, timestamp);

    const rows = server.database.raw
      .prepare('select user_id from artifact_shares where email = ?')
      .all('newcomer@example.com') as { user_id: string | null }[];

    expect(rows[0]?.user_id).toBeNull();
  });
});
