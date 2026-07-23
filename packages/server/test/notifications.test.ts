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

  it('never lets a non-owner make the server email a stranger', async () => {
    // The owner tagging somebody new is a share — that is deliberate, tested
    // below. Anybody else naming a stranger must stay just text until the
    // owner lets them in.
    await comment(colleague, 'Forward this to @nobody@elsewhere.test please');

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

describe('the owner tagging somebody the document is not shared with', () => {
  it('shares the document with them on the spot and emails them once', async () => {
    server.mailer.clear();
    const response = await comment(owner, 'Bringing in @priya@elsewhere.test on this');
    expect(response.status).toBe(201);

    // Exactly one email: the mention, which carries the link. Not a second
    // "shared with you" email on top.
    const theirs = server.mailer.sent.filter((mail) => mail.to === 'priya@elsewhere.test');
    expect(theirs).toHaveLength(1);
    expect(theirs[0]?.subject).toContain('mentioned you');

    // The share is real: once they sign in, the artifact is theirs to read.
    const priya = await signIn(server, 'priya@elsewhere.test');
    expect((await priya.as(`/api/artifacts/${artifact.id}`)).status).toBe(200);

    // And nothing was left waiting on the owner's own approval.
    const requests = (await (await owner.as('/api/access-requests')).json()) as {
      requests: unknown[];
    };
    expect(requests.requests).toHaveLength(0);
  });

  it('rings their bell straight away when they already have an account', async () => {
    const priya = await signIn(server, 'priya@elsewhere.test');
    await comment(owner, 'Bringing in @priya@elsewhere.test on this');

    const inbox = await inboxOf(priya);
    expect(inbox.notifications.some((entry) => entry.type === 'mention')).toBe(true);
  });

  it('says in the response who was shared and who was notified', async () => {
    const body = (await (
      await comment(owner, 'Bringing in @priya@elsewhere.test, and @colleague@example.com knows')
    ).json()) as { mentions: { notified: string[]; shared: string[]; awaitingAccess: string[] } };

    expect(body.mentions.shared).toEqual(['priya@elsewhere.test']);
    expect([...body.mentions.notified].sort()).toEqual([
      'colleague@example.com',
      'priya@elsewhere.test',
    ]);
    expect(body.mentions.awaitingAccess).toEqual([]);
  });

  it('draws on the same sharing budget as the share dialog', async () => {
    // The instance allows two shares an hour here. Naming three new people in
    // one comment shares with two and leaves the third as plain text — a
    // comment must not be a way around the share limit.
    const tight = createTestServer({ SIGNUP_MODE: 'open', MAX_SHARES_PER_HOUR: '2' });
    try {
      const author = await signIn(tight, 'owner@example.com');
      const doc = await author.publish({ type: 'markdown', content: DOCUMENT });

      const body = (await (
        await author.as(
          `/api/artifacts/${doc.id}/comments`,
          jsonBody({ body: 'Adding @one@elsewhere.test @two@elsewhere.test @three@elsewhere.test' }),
        )
      ).json()) as { mentions: { shared: string[] } };

      expect(body.mentions.shared).toHaveLength(2);
      expect(tight.mailer.sent.filter((mail) => mail.subject.includes('mentioned you'))).toHaveLength(2);
    } finally {
      tight.close();
    }
  });
});

describe('tagging somebody covered by a domain share', () => {
  it('notifies them straight away instead of asking the owner about access they have', async () => {
    await owner.as(`/api/artifacts/${artifact.id}/sharing/domains`, jsonBody({ domain: 'zorp.one' }));
    const viaDomain = await signIn(server, 'person@zorp.one');
    server.mailer.clear();

    const body = (await (
      await comment(colleague, 'Looping in @person@zorp.one')
    ).json()) as { mentions: { notified: string[]; awaitingAccess: string[] } };

    expect(body.mentions.notified).toContain('person@zorp.one');
    expect(body.mentions.awaitingAccess).toEqual([]);
    expect(server.mailer.lastTo('person@zorp.one')?.subject).toContain('mentioned you');
    expect(
      (await inboxOf(viaDomain)).notifications.some((entry) => entry.type === 'mention'),
    ).toBe(true);

    const requests = (await (await owner.as('/api/access-requests')).json()) as {
      requests: unknown[];
    };
    expect(requests.requests).toHaveLength(0);
  });
});

describe('tagging an outsider on a public artifact', () => {
  it('notifies them immediately, while comment access still waits on the owner', async () => {
    await owner.as(`/api/artifacts/${artifact.id}/sharing/public`, {
      ...jsonBody({ isPublic: true }),
      method: 'PUT',
    });
    const outsider = await signIn(server, 'outsider@elsewhere.test');
    server.mailer.clear();

    const body = (await (
      await comment(colleague, 'Worth a look from @outsider@elsewhere.test')
    ).json()) as { mentions: { notified: string[]; awaitingAccess: string[] } };

    // They can already read the page — holding the mention would be pointing
    // at an open door. The email and the bell go out now.
    expect(body.mentions.notified).toContain('outsider@elsewhere.test');
    expect(body.mentions.awaitingAccess).toEqual([]);
    expect(server.mailer.lastTo('outsider@elsewhere.test')?.subject).toContain('mentioned you');
    expect((await inboxOf(outsider)).notifications.some((entry) => entry.type === 'mention')).toBe(
      true,
    );

    // What still waits on the owner is the right to comment, not the mention.
    const requests = (await (await owner.as('/api/access-requests')).json()) as {
      requests: unknown[];
    };
    expect(requests.requests).toHaveLength(1);
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
