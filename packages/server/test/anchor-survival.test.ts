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
 * Comments surviving a re-publish.
 *
 * This is the loop the product exists for: an agent publishes, somebody
 * comments on a passage, the agent fixes it and publishes again. If comments
 * lost their place on every update, the loop would not work. If they attached
 * themselves to whatever text happened to move into their position, it would be
 * worse than not working, because nobody would notice.
 *
 * So: keep the place when the passage is still there, admit it and say so when
 * it is not, and never point at anything else.
 */

const VERSION_ONE = `# Quarterly report

Revenue is up eighteen percent on the quarter.

## Europe

Europe was flat this quarter. See the note below.

## India

India grew thirty one percent. See the note below.
`;

let server: TestServer;
let owner: SignedInUser;
let colleague: SignedInUser;
let artifact: PublishedArtifact;

beforeEach(async () => {
  server = createTestServer({ SIGNUP_MODE: 'open' });
  owner = await signIn(server, 'owner@example.com');
  colleague = await signIn(server, 'colleague@example.com');
  artifact = await owner.publish({ type: 'markdown', content: VERSION_ONE });

  await owner.as(
    `/api/artifacts/${artifact.id}/sharing/people`,
    jsonBody({ email: 'colleague@example.com' }),
  );
});

afterEach(() => {
  server.close();
});

interface Thread {
  id: string;
  anchor: { kind: string; headingId?: string | null; snippet?: string };
  anchorLost: boolean;
  comments: { body: string }[];
}

async function comment(
  body: string,
  position?: { headingId: string | null; snippet: string },
): Promise<Thread> {
  const response = await colleague.as(
    `/api/artifacts/${artifact.id}/comments`,
    jsonBody({ body, position }),
  );
  expect(response.status).toBe(201);
  return (await response.json()) as Thread;
}

/** Publishes new content over the top, the way an agent would. */
async function republish(content: string, baseVersion: number): Promise<void> {
  const response = await owner.as(`/api/artifacts/${artifact.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, baseVersion }),
  });
  expect(response.status).toBe(200);
}

async function threads(): Promise<Thread[]> {
  const response = await owner.as(`/api/artifacts/${artifact.id}/comments`);
  return ((await response.json()) as { threads: Thread[] }).threads;
}

describe('a comment whose passage is still there', () => {
  it('keeps its place when the document is rewritten around it', async () => {
    await comment('Is this figure right?', {
      headingId: 'europe',
      snippet: 'Europe was flat this quarter',
    });

    await republish(
      `# Quarterly report

A completely new opening paragraph nobody has read before.

## A brand new section

With brand new content in it.

## Europe

Some new framing first.

Europe was flat this quarter. See the note below.

## India

India grew thirty one percent. See the note below.
`,
      1,
    );

    const [thread] = await threads();
    expect(thread?.anchorLost).toBe(false);
    expect(thread?.anchor).toMatchObject({
      kind: 'text',
      headingId: 'europe',
      snippet: 'Europe was flat this quarter',
    });
  });

  it('keeps its place when the paragraph was reflowed', async () => {
    await comment('Check this', { headingId: 'europe', snippet: 'Europe was flat this quarter' });

    await republish(
      VERSION_ONE.replace(
        'Europe was flat this quarter. See the note below.',
        'Europe was flat this\nquarter. See the note\nbelow.',
      ),
      1,
    );

    const [thread] = await threads();
    expect(thread?.anchorLost).toBe(false);
  });

  it('survives several re-publishes in a row', async () => {
    await comment('Still watching this', {
      headingId: 'europe',
      snippet: 'Europe was flat this quarter',
    });

    await republish(`${VERSION_ONE}\nA first addition.\n`, 1);
    await republish(`${VERSION_ONE}\nA second addition.\n`, 2);
    await republish(`${VERSION_ONE}\nA third addition.\n`, 3);

    const [thread] = await threads();
    expect(thread?.anchorLost).toBe(false);
    expect(thread?.anchor.kind).toBe('text');
  });
});

describe('a comment whose passage is gone', () => {
  it('becomes a comment about the document, and says it lost its place', async () => {
    await comment('Is this figure right?', {
      headingId: 'europe',
      snippet: 'Europe was flat this quarter',
    });

    await republish(
      VERSION_ONE.replace('Europe was flat this quarter. See the note below.', 'Europe grew nine percent.'),
      1,
    );

    const [thread] = await threads();
    expect(thread?.anchor.kind).toBe('document');
    // Said out loud, because a comment that silently changes what it is about
    // is worse than one that admits it lost its place.
    expect(thread?.anchorLost).toBe(true);
    // And what was said is untouched.
    expect(thread?.comments[0]?.body).toBe('Is this figure right?');
  });

  it('never attaches itself to a different copy of the same words', async () => {
    // "See the note below." appears under both headings. This one is India's.
    await comment('Which note?', { headingId: 'india', snippet: 'See the note below.' });

    // India's copy is removed. Europe's is still there.
    await republish(
      VERSION_ONE.replace('India grew thirty one percent. See the note below.', 'India grew thirty one percent.'),
      1,
    );

    const [thread] = await threads();
    // Moving it to Europe's copy would change what the comment appears to be
    // about, and nobody would be able to tell it happened.
    expect(thread?.anchorLost).toBe(true);
    expect(thread?.anchor.kind).toBe('document');
  });

  it('loses its place when the heading it lived under is renamed', async () => {
    await comment('A point about Europe', {
      headingId: 'europe',
      snippet: 'Europe was flat this quarter',
    });

    await republish(VERSION_ONE.replace('## Europe', '## Europe and the Middle East'), 1);

    const [thread] = await threads();
    expect(thread?.anchorLost).toBe(true);
  });
});

describe('comments through the whole loop', () => {
  it('survives publish, comment, fix, re-publish, reply, resolve', async () => {
    // This is the walkthrough the product was designed around.
    const thread = await comment('This figure looks wrong to me.', {
      headingId: 'europe',
      snippet: 'Europe was flat this quarter',
    });

    // The agent asks what is open.
    const open = await owner.as(`/api/artifacts/${artifact.id}/comments?status=open`);
    const found = ((await open.json()) as { threads: Thread[] }).threads;
    expect(found).toHaveLength(1);
    expect(found[0]?.comments[0]?.body).toBe('This figure looks wrong to me.');

    // It fixes the document, leaving the commented sentence in place.
    await republish(
      VERSION_ONE.replace(
        'Europe was flat this quarter. See the note below.',
        'Europe was flat this quarter. See the corrected note below.',
      ),
      1,
    );

    // The comment is still about the same sentence.
    const afterFix = await threads();
    expect(afterFix[0]?.anchorLost).toBe(false);

    // It replies and settles the thread.
    await owner.as(
      `/api/comments/threads/${thread.id}/replies`,
      jsonBody({ body: 'Checked with finance. The figure is right, the note was wrong. Fixed.' }),
    );
    await owner.as(`/api/comments/threads/${thread.id}/status`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'resolved' }),
    });

    // And the person who raised it sees a settled thread with the answer on it.
    const settled = await colleague.as(`/api/artifacts/${artifact.id}/comments?status=resolved`);
    const done = ((await settled.json()) as { threads: Thread[] }).threads;
    expect(done).toHaveLength(1);
    expect(done[0]?.comments).toHaveLength(2);

    // Nothing is left open.
    const stillOpen = await owner.as(`/api/artifacts/${artifact.id}/comments?status=open`);
    expect(((await stillOpen.json()) as { threads: Thread[] }).threads).toHaveLength(0);
  });
});

describe('document-level comments', () => {
  it('are untouched by a re-publish, having no place to lose', async () => {
    await comment('Good overall.');
    await republish('# An entirely different document\n\nNothing of the old one remains.\n', 1);

    const [thread] = await threads();
    expect(thread?.anchor.kind).toBe('document');
    expect(thread?.anchorLost).toBe(false);
    expect(thread?.comments[0]?.body).toBe('Good overall.');
  });
});

describe('what a rejected update does to comments', () => {
  it('nothing: a stale update changes neither the content nor the anchors', async () => {
    await comment('Watching this', { headingId: 'europe', snippet: 'Europe was flat this quarter' });
    await republish(`${VERSION_ONE}\nAn accepted change.\n`, 1);

    // A second agent, still holding version 1, tries to publish something that
    // would have destroyed the anchor.
    const stale = await owner.as(`/api/artifacts/${artifact.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '# Nothing like the original', baseVersion: 1 }),
    });
    expect(stale.status).toBe(409);

    const [thread] = await threads();
    expect(thread?.anchorLost).toBe(false);
    expect(thread?.anchor.kind).toBe('text');
  });
});
