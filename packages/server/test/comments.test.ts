import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTestServer,
  signIn,
  jsonBody,
  type TestServer,
  type SignedInUser,
  type PublishedArtifact,
} from './helpers/server.js';

const DOCUMENT = `# Quarterly report

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
  artifact = await owner.publish({ type: 'markdown', content: DOCUMENT });

  // Somebody has to be able to comment, so share it with them.
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
  status: 'open' | 'resolved';
  anchor: { kind: string; headingId?: string | null; snippet?: string };
  anchorLost: boolean;
  createdAt: string;
  comments: {
    id: string;
    body: string;
    deleted: boolean;
    editedAt: string | null;
    author: { email: string } | null;
  }[];
}

const startThread = (
  as: SignedInUser,
  body: string,
  position?: { headingId: string | null; snippet: string; occurrence?: number },
) => as.as(`/api/artifacts/${artifact.id}/comments`, jsonBody({ body, position }));

const listThreads = async (as: SignedInUser, query = ''): Promise<Thread[]> => {
  const response = await as.as(`/api/artifacts/${artifact.id}/comments${query}`);
  return ((await response.json()) as { threads: Thread[] }).threads;
};

async function threadOf(response: Response): Promise<Thread> {
  return (await response.json()) as Thread;
}

describe('commenting on a passage', () => {
  it('attaches the comment to the text that was selected', async () => {
    const response = await startThread(colleague, 'Is this figure right?', {
      headingId: 'europe',
      snippet: 'Europe was flat this quarter',
    });
    expect(response.status).toBe(201);

    const thread = await threadOf(response);
    expect(thread.anchor).toMatchObject({
      kind: 'text',
      headingId: 'europe',
      snippet: 'Europe was flat this quarter',
    });
    expect(thread.comments[0]?.body).toBe('Is this figure right?');
    expect(thread.comments[0]?.author?.email).toBe('colleague@example.com');
    expect(thread.status).toBe('open');
  });

  it('takes a comment about the whole document when no passage is given', async () => {
    const thread = await threadOf(await startThread(colleague, 'Good overall.'));
    expect(thread.anchor.kind).toBe('document');
  });

  it('refuses a passage that is not in the artifact', async () => {
    // Otherwise a client could invent an anchor and attach a comment to text
    // that was never there.
    const response = await startThread(colleague, 'What?', {
      headingId: 'europe',
      snippet: 'Words that appear nowhere in this document',
    });
    expect(response.status).toBe(400);
  });

  it('asks for more words when the selection is too short to find again', async () => {
    const response = await startThread(colleague, 'Hm', { headingId: 'europe', snippet: 'up' });
    expect(response.status).toBe(400);
    expect(await messageOf(response)).toContain('few more words');
  });

  it('refuses an empty comment', async () => {
    expect((await startThread(colleague, '   ')).status).toBe(400);
  });

  it('allows a comment at a later occurrence of repeated text', async () => {
    const response = await startThread(colleague, 'Which note?', {
      headingId: 'india',
      snippet: 'See the note below.',
      occurrence: 0,
    });
    expect(response.status).toBe(201);
  });

  it('refuses an occurrence that does not exist', async () => {
    const response = await startThread(colleague, 'Which note?', {
      headingId: 'europe',
      snippet: 'See the note below.',
      occurrence: 3,
    });
    expect(response.status).toBe(400);
  });

  it('only allows document-level comments on an HTML artifact', async () => {
    // Its content runs in a sandboxed frame we deliberately cannot reach into,
    // so there is no way to know what was selected or to find it again.
    const dashboard = await owner.publish({ type: 'html', content: '<h1>Dashboard</h1>' });

    const positioned = await owner.as(
      `/api/artifacts/${dashboard.id}/comments`,
      jsonBody({ body: 'This chart', position: { headingId: null, snippet: 'Dashboard' } }),
    );
    expect(positioned.status).toBe(400);
    expect(await messageOf(positioned)).toContain('whole document');

    const documentLevel = await owner.as(
      `/api/artifacts/${dashboard.id}/comments`,
      jsonBody({ body: 'Looks good' }),
    );
    expect(documentLevel.status).toBe(201);
  });
});

describe('who can comment', () => {
  it('the owner, and anybody it is shared with', async () => {
    expect((await startThread(owner, 'A note to self')).status).toBe(201);
    expect((await startThread(colleague, 'A question')).status).toBe(201);
  });

  it('nobody it is not shared with', async () => {
    const stranger = await signIn(server, 'stranger@elsewhere.test');
    expect((await startThread(stranger, 'Hello?')).status).toBe(404);
  });

  it('not a passer-by on a public artifact, even though they can read it', async () => {
    await owner.as(`/api/artifacts/${artifact.id}/sharing/public`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isPublic: true }),
    });

    const passerBy = await signIn(server, 'passerby@elsewhere.test');

    // They can read the artifact and the conversation on it.
    expect((await passerBy.as(`/api/artifacts/${artifact.id}`)).status).toBe(200);
    expect((await passerBy.as(`/api/artifacts/${artifact.id}/comments`)).status).toBe(200);

    // Reading is open to the world; a comment box open to the world is not.
    expect((await startThread(passerBy, 'First!')).status).toBe(404);
  });

  it('nobody signed out', async () => {
    const response = await server.request(
      `/api/artifacts/${artifact.id}/comments`,
      jsonBody({ body: 'Anonymous' }),
    );
    expect(response.status).toBe(401);
  });
});

describe('replying', () => {
  it('adds to the same thread, oldest first', async () => {
    const thread = await threadOf(await startThread(colleague, 'Is this right?'));

    await owner.as(`/api/comments/threads/${thread.id}/replies`, jsonBody({ body: 'Checking now' }));
    await colleague.as(`/api/comments/threads/${thread.id}/replies`, jsonBody({ body: 'Thanks' }));

    const [only] = await listThreads(owner);
    expect(only?.comments.map((comment) => comment.body)).toEqual([
      'Is this right?',
      'Checking now',
      'Thanks',
    ]);
  });

  it('has nowhere to reply to a reply, by construction', async () => {
    // There is no endpoint for it: a reply is another comment on the thread.
    const thread = await threadOf(await startThread(colleague, 'A question'));
    const reply = await owner.as(
      `/api/comments/threads/${thread.id}/replies`,
      jsonBody({ body: 'An answer' }),
    );

    const body = (await reply.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('parentId');
    expect(body.threadId).toBe(thread.id);
  });

  it('is refused for somebody without access', async () => {
    const thread = await threadOf(await startThread(colleague, 'A question'));
    const stranger = await signIn(server, 'stranger@elsewhere.test');

    expect(
      (await stranger.as(`/api/comments/threads/${thread.id}/replies`, jsonBody({ body: 'Hi' })))
        .status,
    ).toBe(404);
  });
});

describe('changing what you said', () => {
  it('lets the author edit, and marks it as edited', async () => {
    const thread = await threadOf(await startThread(colleague, 'Is this rihgt?'));
    const commentId = thread.comments[0]?.id ?? '';

    const response = await colleague.as(`/api/comments/${commentId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'Is this right?' }),
    });
    expect(response.status).toBe(200);

    const edited = (await response.json()) as { body: string; editedAt: string | null };
    expect(edited.body).toBe('Is this right?');
    expect(edited.editedAt).toMatch(/^\d{4}-/);
  });

  it('never lets anybody else edit it, not even the artifact owner', async () => {
    const thread = await threadOf(await startThread(colleague, 'My words'));
    const commentId = thread.comments[0]?.id ?? '';

    const response = await owner.as(`/api/comments/${commentId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'Words I did not write' }),
    });
    expect(response.status).toBe(404);

    const [unchanged] = await listThreads(owner);
    expect(unchanged?.comments[0]?.body).toBe('My words');
  });
});

describe('deleting a comment', () => {
  it('takes the thread with it when nothing else was said', async () => {
    const thread = await threadOf(await startThread(colleague, 'Never mind'));

    const response = await colleague.as(`/api/comments/${thread.comments[0]?.id}`, {
      method: 'DELETE',
    });
    expect(response.status).toBe(200);
    expect((await response.json()) as { threadDeleted: boolean }).toEqual({ threadDeleted: true });

    expect(await listThreads(owner)).toHaveLength(0);
  });

  it('leaves a placeholder when replies came after it', async () => {
    const thread = await threadOf(await startThread(colleague, 'A question'));
    await owner.as(`/api/comments/threads/${thread.id}/replies`, jsonBody({ body: 'An answer' }));

    await colleague.as(`/api/comments/${thread.comments[0]?.id}`, { method: 'DELETE' });

    // The reply must not become an answer to nothing.
    const [remaining] = await listThreads(owner);
    expect(remaining?.comments).toHaveLength(2);
    expect(remaining?.comments[0]?.deleted).toBe(true);
    expect(remaining?.comments[0]?.body).not.toContain('A question');
    expect(remaining?.comments[1]?.body).toBe('An answer');
  });

  it('lets the artifact owner clear something off their own document', async () => {
    const thread = await threadOf(await startThread(colleague, 'Something rude'));

    expect(
      (await owner.as(`/api/comments/${thread.comments[0]?.id}`, { method: 'DELETE' })).status,
    ).toBe(200);
  });

  it('lets nobody else delete it', async () => {
    const other = await signIn(server, 'other@example.com');
    await owner.as(
      `/api/artifacts/${artifact.id}/sharing/people`,
      jsonBody({ email: 'other@example.com' }),
    );

    const thread = await threadOf(await startThread(colleague, 'My comment'));
    expect(
      (await other.as(`/api/comments/${thread.comments[0]?.id}`, { method: 'DELETE' })).status,
    ).toBe(404);
  });

  it('never serves the body again, not even to whoever wrote it', async () => {
    const thread = await threadOf(await startThread(colleague, 'Something private'));
    await owner.as(`/api/comments/threads/${thread.id}/replies`, jsonBody({ body: 'Noted' }));
    await colleague.as(`/api/comments/${thread.comments[0]?.id}`, { method: 'DELETE' });

    const asAuthor = await colleague.as(`/api/artifacts/${artifact.id}/comments`);
    expect(await asAuthor.text()).not.toContain('Something private');
  });
});

describe('settling a thread', () => {
  it('can be resolved and reopened', async () => {
    const thread = await threadOf(await startThread(colleague, 'Is this right?'));

    const resolved = await colleague.as(`/api/comments/threads/${thread.id}/status`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'resolved' }),
    });
    expect(((await resolved.json()) as Thread).status).toBe('resolved');

    const reopened = await colleague.as(`/api/comments/threads/${thread.id}/status`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'open' }),
    });
    expect(((await reopened.json()) as Thread).status).toBe('open');
  });

  it('can be settled by whoever owns the artifact', async () => {
    const thread = await threadOf(await startThread(colleague, 'A question'));

    const response = await owner.as(`/api/comments/threads/${thread.id}/status`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'resolved' }),
    });
    expect(response.status).toBe(200);
  });

  it('cannot be settled by somebody who neither raised it nor owns the artifact', async () => {
    const other = await signIn(server, 'other@example.com');
    await owner.as(
      `/api/artifacts/${artifact.id}/sharing/people`,
      jsonBody({ email: 'other@example.com' }),
    );

    const thread = await threadOf(await startThread(colleague, 'A question'));
    const response = await other.as(`/api/comments/threads/${thread.id}/status`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'resolved' }),
    });
    expect(response.status).toBe(403);
  });
});

describe('reading comments', () => {
  it('filters to open or resolved', async () => {
    const first = await threadOf(await startThread(colleague, 'Still open'));
    const second = await threadOf(await startThread(colleague, 'Settled'));

    await colleague.as(`/api/comments/threads/${second.id}/status`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'resolved' }),
    });

    const open = await listThreads(owner, '?status=open');
    expect(open.map((thread) => thread.id)).toEqual([first.id]);

    const resolved = await listThreads(owner, '?status=resolved');
    expect(resolved.map((thread) => thread.id)).toEqual([second.id]);
  });

  it('filters to what has happened since a timestamp', async () => {
    await startThread(colleague, 'Old news');
    await new Promise((resolve) => setTimeout(resolve, 10));

    const watermark = new Date().toISOString();
    await new Promise((resolve) => setTimeout(resolve, 10));

    await startThread(colleague, 'Brand new');

    const recent = await listThreads(owner, `?since=${encodeURIComponent(watermark)}`);
    expect(recent.map((thread) => thread.comments[0]?.body)).toEqual(['Brand new']);
  });

  it('counts a reply as activity, so an old thread resurfaces', async () => {
    const thread = await threadOf(await startThread(colleague, 'An old question'));
    await new Promise((resolve) => setTimeout(resolve, 10));

    const watermark = new Date().toISOString();
    await new Promise((resolve) => setTimeout(resolve, 10));

    await owner.as(`/api/comments/threads/${thread.id}/replies`, jsonBody({ body: 'A late answer' }));

    // An agent asking "what is new" needs to be told about this.
    const recent = await listThreads(owner, `?since=${encodeURIComponent(watermark)}`);
    expect(recent).toHaveLength(1);
    expect(recent[0]?.id).toBe(thread.id);
  });

  it('refuses a since that is not a timestamp, rather than ignoring it', async () => {
    const response = await owner.as(`/api/artifacts/${artifact.id}/comments?since=last%20tuesday`);
    expect(response.status).toBe(400);
    expect(await messageOf(response)).toContain('UTC');
  });

  it('refuses a status it does not have', async () => {
    expect((await owner.as(`/api/artifacts/${artifact.id}/comments?status=maybe`)).status).toBe(400);
  });

  it('is refused entirely for somebody with no access to the artifact', async () => {
    const stranger = await signIn(server, 'stranger@elsewhere.test');
    expect((await stranger.as(`/api/artifacts/${artifact.id}/comments`)).status).toBe(404);
  });
});

describe('comments and a closed account', () => {
  it('keep their place in the conversation without a name on them', async () => {
    const thread = await threadOf(await startThread(colleague, 'A useful point'));
    await owner.as(`/api/comments/threads/${thread.id}/replies`, jsonBody({ body: 'Agreed' }));

    server.database.raw.prepare('delete from users where id = ?').run(colleague.id);

    // Removing their words would tear holes in a conversation other people are
    // still having.
    const [remaining] = await listThreads(owner);
    expect(remaining?.comments[0]?.body).toBe('A useful point');
    expect(remaining?.comments[0]?.author).toBeNull();
  });
});

async function messageOf(response: Response): Promise<string> {
  return ((await response.json()) as { error: { message: string } }).error.message;
}

describe('commenting without naming a heading', () => {
  it('finds the passage wherever it is in the document', async () => {
    // What an agent does: it has the Markdown, not the rendered heading slugs.
    const response = await colleague.as(
      `/api/artifacts/${artifact.id}/comments`,
      jsonBody({ body: 'Worth a look', position: { snippet: 'India grew thirty one percent' } }),
    );
    expect(response.status).toBe(201);

    const thread = await threadOf(response);
    expect(thread.anchor).toMatchObject({ kind: 'text', headingId: 'india' });
  });

  it('says so when the text appears in more than one place', async () => {
    const response = await colleague.as(
      `/api/artifacts/${artifact.id}/comments`,
      jsonBody({ body: 'Which one?', position: { snippet: 'See the note below.' } }),
    );
    expect(response.status).toBe(400);
    expect(await messageOf(response)).toContain('more than one heading');
  });

  it('still lets a caller name the heading to disambiguate', async () => {
    const response = await colleague.as(
      `/api/artifacts/${artifact.id}/comments`,
      jsonBody({
        body: 'This one',
        position: { headingId: 'india', snippet: 'See the note below.' },
      }),
    );
    expect(response.status).toBe(201);
  });
});
