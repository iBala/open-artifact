import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import {
  createTestServer,
  signIn,
  jsonBody,
  type TestServer,
  type SignedInUser,
  type PublishedArtifact,
} from './helpers/server.js';
import {
  users,
  artifacts,
  artifactVersions,
  artifactShares,
  artifactDomainShares,
  authSessions,
  apiTokens,
  signInCodes,
  deviceCodes,
  commentThreads,
  comments,
  commentMentions,
  accessRequests,
  notifications,
} from '../src/db/schema.js';
import { newId } from '../src/ids.js';
import { nowIso } from '../src/time.js';
import { anonymisedEmailFor } from '../src/auth/account-deletion.js';

/**
 * Closing an account.
 *
 * The promise this ticket makes is one that cannot be made by reading the code:
 * nothing anywhere still points at the person afterwards. So the scenario below
 * is built to touch every table that can hold a reference to somebody, and the
 * last test walks the whole schema column by column rather than trusting a list
 * written by hand. A table added later is checked the day it is added.
 */

const LEAVERS_QUESTION = 'Why does the retry budget reset on every deploy?';
const COLLEAGUES_ANSWER = 'Because the counter lives in memory. Moving it to the database is the fix.';
const LEAVERS_THANKS = 'That makes sense. I will raise it with the platform team.';

let server: TestServer;
let leaver: SignedInUser;
let colleague: SignedInUser;
let leaversReport: PublishedArtifact;
let leaversNotes: PublishedArtifact;
let colleaguesDesignDoc: PublishedArtifact;
/** A command line the leaver signed in from. */
let leaversToken: string;
/** The conversation the leaver started on somebody else's artifact. */
let leaversThreadId: string;
/** The colleague's reply on it, which named the leaver. */
let colleaguesReplyId: string;
/**
 * Notifications put in by hand, held by id. The rest of Sprint 7 writes its own
 * as people comment, so counting rows would be counting somebody else's work.
 */
let notificationToThem: string;
let notificationTheyCaused: string;
let notificationAboutTheirArtifact: string;

beforeEach(async () => {
  server = createTestServer({ SIGNUP_MODE: 'open' });

  leaver = await signIn(server, 'leaver@example.com');
  colleague = await signIn(server, 'colleague@example.com');

  // The leaver's own work: two artifacts, one with a second version, shared with
  // a person, with a domain, and with an address that has never signed in here.
  leaversReport = await leaver.publish({ type: 'markdown', content: '# Quarterly report' });
  leaversNotes = await leaver.publish({ type: 'markdown', content: '# Rough notes' });

  await leaver.as(
    `/api/artifacts/${leaversReport.id}/sharing/people`,
    jsonBody({ email: 'colleague@example.com' }),
  );
  await leaver.as(
    `/api/artifacts/${leaversReport.id}/sharing/people`,
    jsonBody({ email: 'newcomer@elsewhere.test' }),
  );
  await leaver.as(
    `/api/artifacts/${leaversReport.id}/sharing/domains`,
    jsonBody({ domain: 'zorp.one' }),
  );
  await leaver.as(`/api/artifacts/${leaversReport.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '# Quarterly report\n\nRevised.', baseVersion: 1 }),
  });

  // Somebody else's conversation, on the leaver's artifact.
  await colleague.as(
    `/api/artifacts/${leaversReport.id}/comments`,
    jsonBody({ body: 'Where did the revenue figure come from?' }),
  );

  // Somebody else's artifact, shared with the leaver, that the leaver talks on.
  colleaguesDesignDoc = await colleague.publish({ type: 'markdown', content: '# Design doc' });
  await colleague.as(
    `/api/artifacts/${colleaguesDesignDoc.id}/sharing/people`,
    jsonBody({ email: 'leaver@example.com' }),
  );

  leaversThreadId = await startThread(leaver, colleaguesDesignDoc, LEAVERS_QUESTION);
  colleaguesReplyId = await reply(colleague, leaversThreadId, COLLEAGUES_ANSWER);
  await reply(leaver, leaversThreadId, LEAVERS_THANKS);

  // A thread they started and settled themselves, so both of the columns that
  // name somebody on a thread point at them.
  const settled = await startThread(leaver, colleaguesDesignDoc, 'Are the fonts final?');
  await leaver.as(`/api/comments/threads/${settled}/status`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'resolved' }),
  });

  // A second browser and a command line, so there is more than one way in.
  await signIn(server, 'leaver@example.com');
  leaversToken = await approveCommandLine();

  // Notifications, mentions and access requests are put in directly. Closing an
  // account has to handle them whoever wrote them, and these three are the three
  // shapes that matter: one addressed to the person, one they caused, and one
  // about something of theirs.
  const db = server.database.db;

  notificationToThem = newId('ntf');
  notificationTheyCaused = newId('ntf');
  notificationAboutTheirArtifact = newId('ntf');

  db.insert(notifications)
    .values([
      // Theirs, about somebody else's artifact.
      {
        id: notificationToThem,
        userId: leaver.id,
        type: 'share',
        actorUserId: colleague.id,
        artifactId: colleaguesDesignDoc.id,
        createdAt: nowIso(),
      },
      // Somebody else's, caused by them, about somebody else's artifact.
      {
        id: notificationTheyCaused,
        userId: colleague.id,
        type: 'reply',
        actorUserId: leaver.id,
        artifactId: colleaguesDesignDoc.id,
        threadId: leaversThreadId,
        commentId: colleaguesReplyId,
        createdAt: nowIso(),
      },
      // Somebody else's, about the artifact the leaver owns.
      {
        id: notificationAboutTheirArtifact,
        userId: colleague.id,
        type: 'share',
        actorUserId: leaver.id,
        artifactId: leaversReport.id,
        createdAt: nowIso(),
      },
    ])
    .run();

  db.insert(commentMentions)
    .values({
      id: newId('mnt'),
      commentId: colleaguesReplyId,
      email: 'leaver@example.com',
      userId: leaver.id,
    })
    .run();

  db.insert(accessRequests)
    .values([
      // Somebody asked the owner to let the leaver in.
      {
        id: newId('acr'),
        artifactId: colleaguesDesignDoc.id,
        email: 'leaver@example.com',
        requestedByUserId: colleague.id,
        createdAt: nowIso(),
      },
      // The leaver asked the owner to let somebody else in.
      {
        id: newId('acr'),
        artifactId: colleaguesDesignDoc.id,
        email: 'outsider@elsewhere.test',
        requestedByUserId: leaver.id,
        createdAt: nowIso(),
      },
    ])
    .run();

  // A code they asked for and never typed back. Last, so no later sign-in
  // burns it.
  await server.request('/api/auth/code', jsonBody({ email: 'leaver@example.com' }));
});

afterEach(() => {
  server.close();
});

describe('asking to close an account', () => {
  it('refuses without the confirm flag, and says how to go ahead', async () => {
    const response = await leaver.as('/api/auth/account', { method: 'DELETE' });

    expect(response.status).toBe(400);
    expect(await messageOf(response)).toContain('confirm=true');
    // Nothing happened.
    expect(rowsIn(users)).toHaveLength(2);
    expect(rowsIn(artifacts)).toHaveLength(3);
  });

  it('refuses somebody who is not signed in', async () => {
    const response = await server.request('/api/auth/account?confirm=true', { method: 'DELETE' });
    expect(response.status).toBe(401);
    expect(rowsIn(users)).toHaveLength(2);
  });

  it('answers 204 and nothing else', async () => {
    const response = await closeAccount();
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
  });
});

describe('being signed out by closing the account', () => {
  it('kills the session the request was made with', async () => {
    expect((await leaver.as('/api/auth/me')).status).toBe(200);

    await closeAccount();

    expect((await leaver.as('/api/auth/me')).status).toBe(401);
  });

  it('kills the other browsers too, not just the one that asked', async () => {
    expect(rowsIn(authSessions).filter((row) => row.userId === leaver.id)).toHaveLength(2);

    await closeAccount();

    expect(rowsIn(authSessions)).toHaveLength(1);
    expect(rowsIn(authSessions)[0]?.userId).toBe(colleague.id);
  });

  it('kills the command line', async () => {
    const asCommandLine = () =>
      server.request('/api/artifacts', { headers: { Authorization: `Bearer ${leaversToken}` } });

    expect((await asCommandLine()).status).toBe(200);

    await closeAccount();

    expect((await asCommandLine()).status).toBe(401);
    expect(rowsIn(apiTokens)).toHaveLength(0);
  });

  it('throws away a sign-in code they never used', async () => {
    expect(rowsIn(signInCodes).filter((row) => row.email === 'leaver@example.com')).not.toHaveLength(
      0,
    );

    await closeAccount();

    expect(rowsIn(signInCodes).filter((row) => row.email === 'leaver@example.com')).toHaveLength(0);
  });

  it('throws away the command-line sign-in they approved', async () => {
    expect(rowsIn(deviceCodes)).toHaveLength(1);
    await closeAccount();
    expect(rowsIn(deviceCodes)).toHaveLength(0);
  });
});

describe('what closing an account takes with it', () => {
  it('takes every artifact they published', async () => {
    await closeAccount();

    expect(rowsIn(artifacts).map((row) => row.id)).toEqual([colleaguesDesignDoc.id]);
    expect((await colleague.as(`/api/artifacts/${leaversReport.id}`)).status).toBe(404);
    expect((await colleague.as(`/api/artifacts/by-slug/${leaversNotes.slug}`)).status).toBe(404);
  });

  it('takes the version history with them', async () => {
    expect(rowsIn(artifactVersions).filter((row) => row.artifactId === leaversReport.id)).toHaveLength(
      2,
    );

    await closeAccount();

    expect(rowsIn(artifactVersions).filter((row) => row.artifactId === leaversReport.id)).toHaveLength(
      0,
    );
  });

  it('takes who they were shared with, people and domains alike', async () => {
    await closeAccount();

    expect(rowsIn(artifactShares).filter((row) => row.artifactId === leaversReport.id)).toHaveLength(
      0,
    );
    expect(rowsIn(artifactDomainShares)).toHaveLength(0);
  });

  it('takes other people’s comments on their artifacts, because the document is gone', async () => {
    await closeAccount();

    const left = rowsIn(commentThreads).map((row) => row.artifactId);
    expect(left.every((artifactId) => artifactId === colleaguesDesignDoc.id)).toBe(true);
    expect(
      rowsIn(comments).some((row) => row.body === 'Where did the revenue figure come from?'),
    ).toBe(false);
  });

  it('takes invitations that were waiting for their address', async () => {
    // Their colleague had shared the design doc with them.
    expect(
      rowsIn(artifactShares).filter((row) => row.email === 'leaver@example.com'),
    ).toHaveLength(1);

    await closeAccount();

    expect(rowsIn(artifactShares).filter((row) => row.email === 'leaver@example.com')).toHaveLength(
      0,
    );
    // The rest of the design doc's sharing is untouched.
    expect((await colleague.as(`/api/artifacts/${colleaguesDesignDoc.id}`)).status).toBe(200);
  });

  it('takes every notification addressed to them', async () => {
    await closeAccount();

    expect(notificationById(notificationToThem)).toBeUndefined();
    expect(rowsIn(notifications).some((row) => row.userId === leaver.id)).toBe(false);
  });

  it('takes one about their artifact, because there is no artifact to open', async () => {
    await closeAccount();

    expect(notificationById(notificationAboutTheirArtifact)).toBeUndefined();
  });

  it('keeps one they caused in somebody else’s list, with their name off it', async () => {
    await closeAccount();

    const kept = notificationById(notificationTheyCaused);
    expect(kept?.userId).toBe(colleague.id);
    expect(kept?.actorUserId).toBeNull();
    // It still points at the reply it is about, which is still there to read.
    expect(kept?.commentId).toBe(colleaguesReplyId);
  });

  it('takes the mention of them out of somebody else’s comment', async () => {
    await closeAccount();

    expect(
      rowsIn(commentMentions).some(
        (row) => row.userId === leaver.id || row.email === 'leaver@example.com',
      ),
    ).toBe(false);
    // The words that named them are the author's, and are left alone.
    expect(rowsIn(comments).some((row) => row.body === COLLEAGUES_ANSWER)).toBe(true);
  });

  it('takes a request that somebody let them in, and keeps one they raised for somebody else', async () => {
    await closeAccount();

    const left = rowsIn(accessRequests);
    expect(left.some((row) => row.email === 'leaver@example.com')).toBe(false);

    const raisedByThem = left.find((row) => row.email === 'outsider@elsewhere.test');
    // Still waiting on the owner's answer, with no name on it.
    expect(raisedByThem?.requestedByUserId).toBeNull();
    expect(raisedByThem?.decidedAt).toBeNull();
  });
});

describe('what closing an account leaves alone', () => {
  it('keeps their words on somebody else’s artifact, exactly as written', async () => {
    await closeAccount();

    const thread = await threadOn(colleaguesDesignDoc, leaversThreadId);
    expect(thread.comments.map((comment) => comment.body)).toEqual([
      LEAVERS_QUESTION,
      COLLEAGUES_ANSWER,
      LEAVERS_THANKS,
    ]);
    expect(thread.comments.every((comment) => comment.deleted)).toBe(false);
  });

  it('shows them as a deleted user, and everybody else by name', async () => {
    await closeAccount();

    const thread = await threadOn(colleaguesDesignDoc, leaversThreadId);
    expect(thread.comments.map((comment) => comment.author?.email ?? null)).toEqual([
      null,
      'colleague@example.com',
      null,
    ]);
  });

  it('keeps the conversation readable: a question, an answer, and a reply to it', async () => {
    await closeAccount();

    const thread = await threadOn(colleaguesDesignDoc, leaversThreadId);
    // The colleague's answer still answers something. That is the whole reason
    // the words stay rather than going with the account.
    expect(thread.comments[1]?.body).toContain('Because the counter lives in memory');
    expect(thread.comments[0]?.body).toBe(LEAVERS_QUESTION);
    expect(thread.status).toBe('open');
  });

  it('keeps their user row, so the comments have something to point at', async () => {
    await closeAccount();

    const row = server.database.db.select().from(users).where(eq(users.id, leaver.id)).get();
    expect(row).toBeDefined();
    expect(row?.deletedAt).not.toBeNull();
  });
});

describe('the account row that is left behind', () => {
  it('holds no name and no address anybody could recognise', async () => {
    await closeAccount();

    const row = server.database.db.select().from(users).where(eq(users.id, leaver.id)).get();
    expect(row?.displayName).toBeNull();
    expect(row?.email).toBe(anonymisedEmailFor(leaver.id));
    expect(row?.email).not.toContain('leaver@example.com');
    expect(row?.emailVerified).toBe(0);
  });

  it('holds an address no mail can ever reach', async () => {
    await closeAccount();

    const row = server.database.db.select().from(users).where(eq(users.id, leaver.id)).get();
    // .invalid is reserved by RFC 2606 and never resolves, anywhere.
    expect(row?.email.endsWith('@deleted.invalid')).toBe(true);
  });

  it('holds an address that cannot collide with another closed account', async () => {
    const second = await signIn(server, 'second-leaver@example.com');
    await closeAccount();
    expect(
      (await second.as('/api/auth/account?confirm=true', { method: 'DELETE' })).status,
    ).toBe(204);

    const addresses = rowsIn(users)
      .filter((row) => row.deletedAt !== null)
      .map((row) => row.email);
    expect(addresses).toHaveLength(2);
    expect(new Set(addresses).size).toBe(2);
  });

  it('frees the address they signed up with, without handing over their words', async () => {
    await closeAccount();

    // Somebody with that address can start again from nothing.
    const newcomer = await signIn(server, 'leaver@example.com');
    expect(newcomer.id).not.toBe(leaver.id);

    // And what the person before them said is not theirs.
    const thread = await threadOn(colleaguesDesignDoc, leaversThreadId);
    expect(thread.comments[0]?.author).toBeNull();
  });
});

describe('nothing anywhere still points at them', () => {
  it('starts from a scenario that points at them from every table that can', () => {
    // Without this the walk below could pass on an empty database. Every place
    // named here is a place the deletion has to reach.
    expect(rowsHolding(leaver.id)).toEqual(
      expect.arrayContaining([
        'users.id',
        'auth_sessions.user_id',
        'api_tokens.user_id',
        'device_codes.approved_by_user_id',
        'artifacts.owner_id',
        'artifact_shares.user_id',
        'artifact_shares.created_by_user_id',
        'artifact_domain_shares.created_by_user_id',
        'comment_threads.created_by_user_id',
        'comment_threads.resolved_by_user_id',
        'comments.author_id',
        'comment_mentions.user_id',
        'access_requests.requested_by_user_id',
        'notifications.user_id',
        'notifications.actor_user_id',
      ]),
    );
    expect(rowsHolding('leaver@example.com')).toEqual(
      expect.arrayContaining([
        'users.email',
        'artifact_shares.email',
        'sign_in_codes.email',
        'comment_mentions.email',
        'access_requests.email',
      ]),
    );
  });

  it('holds their id nowhere afterwards, except on the row that is them', async () => {
    await closeAccount();

    // Walked column by column across the whole schema rather than checked
    // against a list, so a table added later is covered the day it is added.
    expect(rowsHolding(leaver.id)).toEqual(['users.id']);
  });

  it('holds the address they signed up with nowhere at all', async () => {
    await closeAccount();

    expect(rowsHolding('leaver@example.com')).toEqual([]);
  });

  it('holds nothing that belonged to the artifacts it deleted', async () => {
    await closeAccount();

    expect(rowsHolding(leaversReport.id)).toEqual([]);
    expect(rowsHolding(leaversNotes.id)).toEqual([]);
  });

  it('leaves the colleague’s account exactly as it was', async () => {
    const before = server.database.db.select().from(users).where(eq(users.id, colleague.id)).get();

    await closeAccount();

    const after = server.database.db.select().from(users).where(eq(users.id, colleague.id)).get();
    expect(after).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function closeAccount(): Promise<Response> {
  return leaver.as('/api/auth/account?confirm=true', { method: 'DELETE' });
}

/** Every row in a table, straight out of the database. */
function rowsIn<T extends SQLiteTable>(table: T): T['$inferSelect'][] {
  return server.database.db.select().from(table).all() as T['$inferSelect'][];
}

function notificationById(id: string) {
  return server.database.db.select().from(notifications).where(eq(notifications.id, id)).get();
}

async function startThread(
  person: SignedInUser,
  artifact: PublishedArtifact,
  body: string,
): Promise<string> {
  const response = await person.as(`/api/artifacts/${artifact.id}/comments`, jsonBody({ body }));
  if (response.status !== 201) {
    throw new Error(`could not start a thread: ${response.status} ${await response.text()}`);
  }
  return ((await response.json()) as { id: string }).id;
}

async function reply(person: SignedInUser, threadId: string, body: string): Promise<string> {
  const response = await person.as(`/api/comments/threads/${threadId}/replies`, jsonBody({ body }));
  if (response.status !== 201) {
    throw new Error(`could not reply: ${response.status} ${await response.text()}`);
  }
  return ((await response.json()) as { id: string }).id;
}

interface ThreadView {
  id: string;
  status: string;
  comments: {
    body: string;
    deleted: boolean;
    author: { id: string; email: string; displayName: string | null } | null;
  }[];
}

/** Reads a thread back the way the artifact's owner sees it. */
async function threadOn(artifact: PublishedArtifact, threadId: string): Promise<ThreadView> {
  const response = await colleague.as(`/api/artifacts/${artifact.id}/comments`);
  const body = (await response.json()) as { threads: ThreadView[] };
  const thread = body.threads.find((candidate) => candidate.id === threadId);
  if (!thread) throw new Error(`no thread ${threadId} on ${artifact.id}`);
  return thread;
}

/** Signs a command line in the way a person actually would. */
async function approveCommandLine(): Promise<string> {
  const started = (await (
    await server.request('/api/auth/device', jsonBody({ label: 'Claude Code' }))
  ).json()) as { deviceCode: string; userCode: string };

  await leaver.as('/api/auth/device/approve', jsonBody({ userCode: started.userCode }));

  const polled = (await (
    await server.request('/api/auth/device/token', jsonBody({ deviceCode: started.deviceCode }))
  ).json()) as { token: string };

  return polled.token;
}

/**
 * Every place in the database holding this exact value, as "table.column".
 *
 * Reads the schema out of SQLite rather than out of a list in this file, so a
 * table somebody adds next sprint is walked without anybody remembering to come
 * back here.
 */
function rowsHolding(value: string): string[] {
  const raw = server.database.raw;

  const tables = raw
    .prepare(
      `select name from sqlite_master
       where type = 'table' and name not like 'sqlite_%' and name not like '\\_\\_%' escape '\\'`,
    )
    .all() as { name: string }[];

  const found: string[] = [];

  for (const { name } of tables) {
    const columns = raw.prepare(`pragma table_info("${name}")`).all() as { name: string }[];
    for (const column of columns) {
      const row = raw
        .prepare(`select count(*) as count from "${name}" where "${column.name}" = ?`)
        .get(value) as { count: number };
      if (row.count > 0) found.push(`${name}.${column.name}`);
    }
  }

  return found.sort();
}

async function messageOf(response: Response): Promise<string> {
  return ((await response.json()) as { error: { message: string } }).error.message;
}

describe('signing in again afterwards', () => {
  it('is refused for the anonymised address, whatever happens to reach it', async () => {
    // Deletion rewrites the address to one that cannot receive mail, so nobody
    // could get a code for it. This is the check that still refuses if that
    // ever stopped being true.
    const { AuthService } = await import('../src/auth/service.js');
    const { openDatabase } = await import('../src/db/index.js');
    const { users } = await import('../src/db/schema.js');

    const handle = openDatabase({ path: ':memory:' });
    try {
      const auth = new AuthService({
        db: handle.db,
        sessionSecret: 'a-secret-long-enough-for-the-config-check',
        signupMode: 'open',
        signupAllowedDomains: [],
      });

      const timestamp = '2026-07-22T00:00:00.000Z';
      handle.db
        .insert(users)
        .values({
          id: 'usr_closed',
          email: 'closed@example.com',
          emailVerified: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
          deletedAt: timestamp,
        })
        .run();

      expect(() => auth.findOrCreateUser('closed@example.com', { verified: true })).toThrow(
        /closed/i,
      );
    } finally {
      handle.close();
    }
  });
});
