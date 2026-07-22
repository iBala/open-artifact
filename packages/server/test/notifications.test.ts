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
 * Being told things happened.
 *
 * The rule these tests exist to hold down is what a mention does when the
 * person named cannot see the artifact. Telling them they were mentioned on a
 * document they cannot open is pointing at a door and not giving them the key,
 * so that notification is held until somebody who can grant access does.
 */

const DOCUMENT = `# Quarterly report

Revenue is up eighteen percent on the quarter.
`;

let server: TestServer;
let owner: SignedInUser;
let colleague: SignedInUser;
let artifact: PublishedArtifact;

beforeEach(async () => {
  server = createTestServer({ SIGNUP_MODE: 'open' });
  owner = await signIn(server, 'owner@example.com');
  colleague = await signIn(server, 'colleague@example.com');
  artifact = await owner.publish({ type: 'markdown', content: DOCUMENT });

  await owner.as(
    `/api/artifacts/${artifact.id}/sharing/people`,
    jsonBody({ email: 'colleague@example.com' }),
  );
});

afterEach(() => {
  server.close();
});

interface Notification {
  id: string;
  type: string;
  read: boolean;
  summary: string;
  artifact: { slug: string; title: string } | null;
  threadId: string | null;
}

async function inboxOf(as: SignedInUser): Promise<{ notifications: Notification[]; unread: number }> {
  const response = await as.as('/api/notifications');
  expect(response.status).toBe(200);
  return (await response.json()) as { notifications: Notification[]; unread: number };
}

const comment = (as: SignedInUser, body: string) =>
  as.as(`/api/artifacts/${artifact.id}/comments`, jsonBody({ body }));

describe('being shared something', () => {
  it('puts it in your notifications', async () => {
    const inbox = await inboxOf(colleague);

    expect(inbox.notifications).toHaveLength(1);
    expect(inbox.notifications[0]).toMatchObject({ type: 'share', read: false });
    expect(inbox.notifications[0]?.summary).toContain('shared');
    expect(inbox.notifications[0]?.artifact?.title).toBe('Quarterly report');
    expect(inbox.unread).toBe(1);
  });

  it('tells nobody else', async () => {
    const bystander = await signIn(server, 'bystander@elsewhere.test');
    expect((await inboxOf(bystander)).notifications).toHaveLength(0);
  });
});

describe('being mentioned', () => {
  it('tells the person named', async () => {
    await comment(owner, 'Can you check this, @colleague@example.com?');

    const inbox = await inboxOf(colleague);
    const mention = inbox.notifications.find((entry) => entry.type === 'mention');

    expect(mention).toBeTruthy();
    expect(mention?.summary).toContain('mentioned you');
    expect(mention?.threadId).toBeTruthy();
  });

  it('does not tell you when you name yourself', async () => {
    await comment(colleague, 'Note to self, @colleague@example.com');

    const mentions = (await inboxOf(colleague)).notifications.filter(
      (entry) => entry.type === 'mention',
    );
    expect(mentions).toHaveLength(0);
  });

  it('ignores an address typed at random', async () => {
    // Otherwise a comment box is a way to make the server email a stranger.
    await comment(owner, 'Forward this to @nobody@elsewhere.test please');

    const stranger = await signIn(server, 'nobody@elsewhere.test');
    const mentions = (await inboxOf(stranger)).notifications.filter(
      (entry) => entry.type === 'mention',
    );
    expect(mentions).toHaveLength(0);
  });

  it('reads the address out of ordinary punctuation', async () => {
    await comment(owner, 'Ask @colleague@example.com, then move on.');

    const mention = (await inboxOf(colleague)).notifications.find(
      (entry) => entry.type === 'mention',
    );
    expect(mention).toBeTruthy();
  });
});

describe('mentioning somebody who cannot see the artifact', () => {
  it('asks the owner instead of telling the outsider', async () => {
    const outsider = await signIn(server, 'outsider@elsewhere.test');

    await comment(colleague, 'This needs @outsider@elsewhere.test to look at it');

    // The owner is asked, because they are the only one who can let them in.
    const request = (await inboxOf(owner)).notifications.find(
      (entry) => entry.type === 'access-request',
    );
    expect(request).toBeTruthy();
    expect(request?.summary).toContain('wants to add somebody');

    // The outsider is told nothing yet.
    expect((await inboxOf(outsider)).notifications).toHaveLength(0);
  });

  it('releases the held mention the moment access is granted', async () => {
    const outsider = await signIn(server, 'outsider@elsewhere.test');
    await comment(colleague, 'This needs @outsider@elsewhere.test to look at it');

    const requests = (await (await owner.as('/api/access-requests')).json()) as {
      requests: { id: string; email: string }[];
    };
    expect(requests.requests).toHaveLength(1);

    await owner.as(
      `/api/access-requests/${requests.requests[0]?.id}/decide`,
      jsonBody({ grant: true }),
    );

    // Now it is worth telling them, because now they can open it.
    const inbox = await inboxOf(outsider);
    expect(inbox.notifications.some((entry) => entry.type === 'mention')).toBe(true);
    expect((await outsider.as(`/api/artifacts/${artifact.id}`)).status).toBe(200);
  });

  it('never releases it when the owner says no', async () => {
    const outsider = await signIn(server, 'outsider@elsewhere.test');
    await comment(colleague, 'This needs @outsider@elsewhere.test to look at it');

    const requests = (await (await owner.as('/api/access-requests')).json()) as {
      requests: { id: string }[];
    };
    await owner.as(
      `/api/access-requests/${requests.requests[0]?.id}/decide`,
      jsonBody({ grant: false }),
    );

    expect((await inboxOf(outsider)).notifications).toHaveLength(0);
    expect((await outsider.as(`/api/artifacts/${artifact.id}`)).status).toBe(404);
  });

  it('releases a held mention when the artifact is shared by any other route', async () => {
    // The reason for holding was never the request, it was the lack of access.
    const outsider = await signIn(server, 'outsider@elsewhere.test');
    await comment(colleague, 'This needs @outsider@elsewhere.test to look at it');

    await owner.as(
      `/api/artifacts/${artifact.id}/sharing/people`,
      jsonBody({ email: 'outsider@elsewhere.test' }),
    );

    expect((await inboxOf(outsider)).notifications.some((entry) => entry.type === 'mention')).toBe(
      true,
    );
  });

  it('lets nobody but the owner answer a request', async () => {
    await signIn(server, 'outsider@elsewhere.test');
    await comment(colleague, 'This needs @outsider@elsewhere.test to look at it');

    // The person who asked cannot grant it themselves.
    const theirs = (await (await colleague.as('/api/access-requests')).json()) as {
      requests: unknown[];
    };
    expect(theirs.requests).toHaveLength(0);
  });
});

describe('replies', () => {
  it('tell everybody already on the thread', async () => {
    const thread = (await (await comment(colleague, 'A question')).json()) as { id: string };
    await owner.as(`/api/comments/threads/${thread.id}/replies`, jsonBody({ body: 'An answer' }));

    const reply = (await inboxOf(colleague)).notifications.find((entry) => entry.type === 'reply');
    expect(reply?.summary).toContain('replied');
  });

  it('do not tell the person who wrote them', async () => {
    const thread = (await (await comment(colleague, 'A question')).json()) as { id: string };
    await colleague.as(
      `/api/comments/threads/${thread.id}/replies`,
      jsonBody({ body: 'Answering myself' }),
    );

    const replies = (await inboxOf(colleague)).notifications.filter(
      (entry) => entry.type === 'reply',
    );
    expect(replies).toHaveLength(0);
  });

  it('do not arrive twice when the reply also names you', async () => {
    // Being mentioned is the more specific thing to be told.
    const thread = (await (await comment(colleague, 'A question')).json()) as { id: string };
    await owner.as(
      `/api/comments/threads/${thread.id}/replies`,
      jsonBody({ body: 'Answering @colleague@example.com directly' }),
    );

    const inbox = await inboxOf(colleague);
    expect(inbox.notifications.filter((entry) => entry.type === 'reply')).toHaveLength(0);
    expect(inbox.notifications.filter((entry) => entry.type === 'mention')).toHaveLength(1);
  });
});

describe('who can be named', () => {
  it('is the people it is shared with and anybody who has commented, never everybody', async () => {
    // A stranger with an account must not appear just because they exist.
    await signIn(server, 'stranger@elsewhere.test');

    const response = await owner.as(`/api/artifacts/${artifact.id}/mention-candidates`);
    const body = (await response.json()) as { candidates: { email: string }[] };

    const emails = body.candidates.map((candidate) => candidate.email);
    expect(emails).toContain('owner@example.com');
    expect(emails).toContain('colleague@example.com');
    expect(emails).not.toContain('stranger@elsewhere.test');
  });

  it('includes somebody who has commented but was never explicitly shared with', async () => {
    await owner.as(`/api/artifacts/${artifact.id}/sharing/domains`, jsonBody({ domain: 'zorp.one' }));
    const viaDomain = await signIn(server, 'person@zorp.one');
    await comment(viaDomain, 'Adding my view');

    const body = (await (
      await owner.as(`/api/artifacts/${artifact.id}/mention-candidates`)
    ).json()) as { candidates: { email: string }[] };

    expect(body.candidates.map((candidate) => candidate.email)).toContain('person@zorp.one');
  });

  it('is refused to somebody who cannot comment', async () => {
    const stranger = await signIn(server, 'stranger@elsewhere.test');
    expect((await stranger.as(`/api/artifacts/${artifact.id}/mention-candidates`)).status).toBe(404);
  });
});

describe('reading and clearing', () => {
  it('marks one as read without touching the others', async () => {
    await comment(owner, 'Look at this @colleague@example.com');

    const before = await inboxOf(colleague);
    expect(before.unread).toBe(2);

    await colleague.as(`/api/notifications/${before.notifications[0]?.id}/read`, { method: 'POST' });

    const after = await inboxOf(colleague);
    expect(after.unread).toBe(1);
  });

  it('clears everything at once', async () => {
    await comment(owner, 'Look at this @colleague@example.com');
    await colleague.as('/api/notifications/read-all', { method: 'POST' });

    expect((await inboxOf(colleague)).unread).toBe(0);
  });

  it('never lets one person mark another person’s as read', async () => {
    const theirs = (await inboxOf(colleague)).notifications[0];
    await owner.as(`/api/notifications/${theirs?.id}/read`, { method: 'POST' });

    // Still unread, because it was never the other person's to touch.
    expect((await inboxOf(colleague)).unread).toBe(1);
  });

  it('needs somebody signed in', async () => {
    expect((await server.request('/api/notifications')).status).toBe(401);
  });
});

describe('the email a mention sends', () => {
  it('carries what was said, so the inbox is enough to judge whether it matters', async () => {
    server.mailer.clear();
    await comment(owner, 'Can you check the Europe figure, @colleague@example.com?');

    const email = server.mailer.lastTo('colleague@example.com');
    expect(email?.subject).toContain('mentioned you');
    expect(email?.subject).toContain('Quarterly report');
    expect(email?.text).toContain('Can you check the Europe figure');
    // Straight to the comment, not the top of the document.
    expect(email?.text).toContain('thread=');
  });

  it('goes to nobody who is still waiting to be let in', async () => {
    await signIn(server, 'outsider@elsewhere.test');
    server.mailer.clear();

    await comment(colleague, 'We need @outsider@elsewhere.test here');

    // Telling them by email would be the same mistake as telling them in app:
    // pointing at a document they cannot open.
    expect(server.mailer.lastTo('outsider@elsewhere.test')).toBeUndefined();
  });

  it('goes out once they are let in', async () => {
    await signIn(server, 'outsider@elsewhere.test');
    await comment(colleague, 'We need @outsider@elsewhere.test here');

    const requests = (await (await owner.as('/api/access-requests')).json()) as {
      requests: { id: string }[];
    };
    server.mailer.clear();
    await owner.as(
      `/api/access-requests/${requests.requests[0]?.id}/decide`,
      jsonBody({ grant: true }),
    );

    // The share email tells them there is something for them, which is the
    // thing that now matters.
    expect(server.mailer.lastTo('outsider@elsewhere.test')).toBeTruthy();
  });
});

describe('mentioning somebody who has access but has never signed in', () => {
  it('emails them, because that is how they find out about anything here', async () => {
    // Sharing with an address that has no account is the ordinary case in this
    // product, so a mention of that address cannot silently do nothing.
    await owner.as(
      `/api/artifacts/${artifact.id}/sharing/people`,
      jsonBody({ email: 'newcomer@example.com' }),
    );
    server.mailer.clear();

    await comment(owner, 'Adding @newcomer@example.com to this');

    const email = server.mailer.lastTo('newcomer@example.com');
    expect(email?.subject).toContain('mentioned you');
  });

  it('and puts it on their bell once they sign in and are mentioned again', async () => {
    await owner.as(
      `/api/artifacts/${artifact.id}/sharing/people`,
      jsonBody({ email: 'newcomer@example.com' }),
    );

    const newcomer = await signIn(server, 'newcomer@example.com');
    await comment(owner, 'Still needs @newcomer@example.com');

    const inbox = await inboxOf(newcomer);
    expect(inbox.notifications.some((entry) => entry.type === 'mention')).toBe(true);
  });
});
