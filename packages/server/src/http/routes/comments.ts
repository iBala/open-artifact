/**
 * The comment API.
 *
 * Every route here loads the artifact first and asks artifacts/access.ts what
 * this person may do with it. Commenting needs an explicit share: reading a
 * public artifact is open to the world, and a comment box open to the world is a
 * different product with different problems.
 *
 * Reading comments needs only view access, so somebody following a public link
 * can see the conversation without being able to join it.
 */

import type { Hono } from 'hono';
import type { AppContext, AppEnv } from '../app.js';
import { ApiError } from '../../errors.js';
import { requireUser, currentUser } from '../session.js';

import { requireAccess } from '../../artifacts/access.js';
import type { ThreadStatus, CommentPosition } from '../../comments/service.js';
import { anchorForElement, sourceExcerpt } from '../../comments/html-source.js';
import { mentionEmail } from '../../mail/templates.js';
import { instanceNameFrom } from './auth.js';

export function registerCommentRoutes(app: Hono<AppEnv>, context: AppContext): void {
  const { artifacts, sharing, comments, notifications, config, mailer , rateLimiter } = context;

  const commentLimit = rateLimiter.middleware({
    by: 'user',
    bucket: 'comment',
    limit: config.limits.commentsPerHour,
    windowSeconds: 3600,
  });

  /**
   * The same sharing budget the share dialog spends. An owner tagging somebody
   * new in a comment shares the document, so it must count against the same
   * hourly allowance rather than around it.
   */
  const shareBudgetFor = (userId: string) => () =>
    rateLimiter.check('share', userId, {
      limit: config.limits.sharesPerHour,
      windowSeconds: 3600,
    }) === null;

  /**
   * Emails everybody a comment named who can already see the artifact.
   *
   * Only them: somebody who has to wait for the owner to let them in is told
   * nothing yet, in app or by email. Failures are swallowed by the mailer, so a
   * comment is never lost because a notification could not go out.
   */
  async function emailMentions(input: {
    outcome: { notified: string[] };
    artifact: { slug: string; title: string };
    author: { email: string; displayName: string | null };
    threadId: string;
    body: string;
  }): Promise<void> {
    for (const address of input.outcome.notified) {
      const content = mentionEmail({
        mentionedBy: input.author.displayName ?? input.author.email,
        artifactTitle: input.artifact.title,
        excerpt: input.body.length > 240 ? `${input.body.slice(0, 240).trimEnd()}…` : input.body,
        url: `${config.baseUrl}/a/${input.artifact.slug}?thread=${input.threadId}`,
        instanceName: instanceNameFrom(config.baseUrl),
      });
      await mailer.send({
        to: address,
        subject: content.subject,
        text: content.text,
        html: content.html,
      });
    }
  }

  /** Loads an artifact and checks what this caller may do with it. */
  function artifactFor(id: string, action: 'view' | 'comment', c: Parameters<typeof currentUser>[0]) {
    const artifact = artifacts.get(id);
    requireAccess(c.get('user') ?? null, sharing.accessFactsFor(artifact), action);
    return artifact;
  }

  /** Everything said about an artifact. */
  app.get('/api/artifacts/:id/comments', (c) => {
    const artifact = artifactFor(c.req.param('id'), 'view', c);

    const status = c.req.query('status');
    if (status !== undefined && status !== 'open' && status !== 'resolved') {
      throw new ApiError('validation_failed', 'status must be "open" or "resolved".');
    }

    return c.json({
      threads: comments.list(artifact.id, {
        since: c.req.query('since'),
        status: status as ThreadStatus | undefined,
      }),
    });
  });

  /**
   * What an element anchor would resolve to, before anybody types a comment.
   *
   * The reader selects inside a sandboxed frame, and the page in that frame is
   * a stranger's. Nothing it sends is drawn in the app's own chrome: the frame
   * hands over an element handle, this route resolves it against the stored
   * source, and the composer quotes the answer from here. Escaping what the
   * frame sent would stop script; it would not stop a hostile page painting
   * "your session has expired, sign in at…" into trusted UI.
   *
   * It also spares the reader the worst of the old flow, where an element that
   * could not be anchored to was only refused after they had written something.
   */
  app.post('/api/artifacts/:id/anchor-preview', requireUser, async (c) => {
    const artifact = artifactFor(c.req.param('id'), 'comment', c);
    const body = await readJson(c.req.raw);

    if (artifact.type === 'markdown') {
      throw new ApiError(
        'validation_failed',
        'Element anchors are for HTML artifacts. A passage of a Markdown document is anchored by its text.',
      );
    }

    const position = readElementPosition(body);
    const built = anchorForElement(artifact.content, {
      elementId: 'elementId' in position ? position.elementId : null,
      path: 'path' in position ? position.path : null,
      snippet: 'snippet' in position ? position.snippet : null,
    });

    if (!built.ok) {
      // Not an error: "you cannot comment there" is an ordinary answer to this
      // question, and the composer needs to say so without a failed request.
      return c.json({ found: false, reason: built.reason });
    }

    const range = sourceExcerpt(artifact.content, built.anchor);

    return c.json({
      found: true,
      tag: built.anchor.tag,
      elementId: built.anchor.elementId,
      path: built.anchor.path,
      snippet: built.anchor.snippet,
      startLine: range?.startLine ?? null,
      endLine: range?.endLine ?? null,
      version: artifact.version,
    });
  });

  /** Start a thread, about a passage or about the whole document. */
  app.post('/api/artifacts/:id/comments', requireUser, commentLimit, async (c) => {
    const artifact = artifactFor(c.req.param('id'), 'comment', c);
    const body = await readJson(c.req.raw);

    const author = currentUser(c);
    const position = readPosition(body);

    // An anchor is worked out against the artifact as this request read it. If a
    // new version landed while the reader was choosing their words, the passage
    // they picked may already be gone — and worse, relocation has already run
    // for that new version, so a thread created now would never be re-checked
    // and would sit pointing at text nobody can see. Callers that know which
    // version they were reading say so, and are told to look again.
    requireCurrentVersion(body, artifact.version, position !== undefined);

    const thread = comments.startThread({
      artifact,
      author,
      body: requireString(body, 'body'),
      position,
    });

    const first = thread.comments[0];
    let mentions = { notified: [], shared: [], awaitingAccess: [] } as Awaited<
      ReturnType<typeof notifications.recordMentions>
    >;
    if (first) {
      const facts = sharing.accessFactsFor(artifact);
      mentions = notifications.recordMentions({
        comment: { id: first.id, body: first.body, threadId: thread.id },
        artifact,
        author,
        candidates: notifications.mentionCandidates(artifact.id, facts.sharedEmails),
        sharedDomains: facts.sharedDomains,
        canGrantAccess: author.id === artifact.ownerId,
        shareBudget: shareBudgetFor(author.id),
      });

      await emailMentions({
        outcome: mentions,
        artifact,
        author,
        threadId: thread.id,
        body: first.body,
      });
    }

    // The outcome rides along so the composer can say what the tags did —
    // silence after tagging somebody is what made this feature feel broken.
    return c.json({ ...thread, mentions }, 201);
  });

  /** Reply on a thread. */
  app.post('/api/comments/threads/:threadId/replies', requireUser, commentLimit, async (c) => {
    const threadId = c.req.param('threadId');
    const artifact = artifactFor(comments.artifactIdFor(threadId), 'comment', c);
    const author = currentUser(c);
    const body = await readJson(c.req.raw);

    const reply = comments.reply(threadId, author, requireString(body, 'body'));

    const facts = sharing.accessFactsFor(artifact);
    const mentions = notifications.recordMentions({
      comment: { id: reply.id, body: reply.body, threadId },
      artifact,
      author,
      candidates: notifications.mentionCandidates(artifact.id, facts.sharedEmails),
      sharedDomains: facts.sharedDomains,
      canGrantAccess: author.id === artifact.ownerId,
      shareBudget: shareBudgetFor(author.id),
    });

    notifications.notifyReply({
      comment: { id: reply.id, threadId },
      artifact,
      author,
      participantIds: comments.participantsOn(threadId),
    });

    await emailMentions({ outcome: mentions, artifact, author, threadId, body: reply.body });

    return c.json({ ...reply, mentions }, 201);
  });

  /** Settle a thread, or reopen it. */
  app.put('/api/comments/threads/:threadId/status', requireUser, async (c) => {
    const threadId = c.req.param('threadId');
    const artifact = artifactFor(comments.artifactIdFor(threadId), 'comment', c);

    const body = await readJson(c.req.raw);
    const status = requireString(body, 'status');
    if (status !== 'open' && status !== 'resolved') {
      throw new ApiError('validation_failed', 'status must be "open" or "resolved".');
    }

    return c.json(comments.setStatus(threadId, currentUser(c), artifact.ownerId, status));
  });

  /**
   * Change what you said.
   *
   * Deliberately not offered by the skill. An agent rewriting its own earlier
   * words in a conversation somebody else is reading is a bad shape, so editing
   * stays something a person does in the browser.
   */
  app.put('/api/comments/:commentId', requireUser, async (c) => {
    const commentId = c.req.param('commentId');
    artifactFor(comments.artifactIdForComment(commentId), 'comment', c);

    const body = await readJson(c.req.raw);
    return c.json(comments.edit(commentId, currentUser(c), requireString(body, 'body')));
  });

  /** Delete a comment. Yours, or anything on an artifact you own. */
  app.delete('/api/comments/:commentId', requireUser, (c) => {
    const commentId = c.req.param('commentId');
    const artifact = artifactFor(comments.artifactIdForComment(commentId), 'comment', c);

    return c.json(comments.delete(commentId, currentUser(c), artifact.ownerId));
  });
}

/**
 * The optional position a comment is attached to.
 *
 * Two shapes, because the two document formats are not alike. A Markdown
 * position names the passage that was selected. An HTML position names the
 * element, because rendered HTML text is not its source and a passage cannot be
 * found again in the bytes an agent edits. A position naming an element is read
 * as one; anything else is read as a passage, and the service refuses whichever
 * does not suit the document.
 */
function readPosition(body: Record<string, unknown>): CommentPosition | undefined {
  const position = body.position;
  if (position === undefined || position === null) return undefined;

  if (typeof position !== 'object' || Array.isArray(position)) {
    throw new ApiError('validation_failed', 'position must be an object, or left out entirely.');
  }

  const value = position as Record<string, unknown>;

  if ('elementId' in value || 'path' in value) {
    return readElementPosition(value);
  }

  const snippet = value.snippet;
  if (typeof snippet !== 'string') {
    throw new ApiError('validation_failed', 'position.snippet is required and must be text.');
  }

  // Absent and null mean different things here, so they are kept apart. Absent
  // means "find it wherever it is"; null means "the part before the first
  // heading". Collapsing them would make one of the two impossible to ask for.
  const namesAHeading = 'headingId' in value;
  const headingId = value.headingId;
  if (namesAHeading && headingId !== null && typeof headingId !== 'string') {
    throw new ApiError('validation_failed', 'position.headingId must be text or null.');
  }

  const occurrence = value.occurrence ?? 0;
  if (typeof occurrence !== 'number' || !Number.isInteger(occurrence) || occurrence < 0) {
    throw new ApiError('validation_failed', 'position.occurrence must be a whole number from zero.');
  }

  return {
    ...(namesAHeading ? { headingId: headingId as string | null } : {}),
    snippet,
    occurrence,
  };
}

/**
 * Refuses a positioned comment written against a version that has moved on.
 *
 * Optional on purpose. Clients that shipped before this send no baseVersion and
 * keep working exactly as they did; the check is there for the ones that can say
 * what they were looking at. A comment on the whole document does not need it —
 * it is about the artifact, not about any particular text in it.
 */
function requireCurrentVersion(
  body: Record<string, unknown>,
  current: number,
  positioned: boolean,
): void {
  const claimed = body.baseVersion;
  if (claimed === undefined || claimed === null) return;

  if (typeof claimed !== 'number' || !Number.isInteger(claimed)) {
    throw new ApiError('validation_failed', 'baseVersion must be a whole number.');
  }

  if (positioned && claimed !== current) {
    throw new ApiError(
      'version_conflict',
      `This page changed while you were reading it. It is now version ${current}. Reload and pick the passage again, so your comment lands on what is there now.`,
    );
  }
}

/** An element in an HTML artifact, named by id or by path. */
function readElementPosition(value: Record<string, unknown>): CommentPosition {
  const elementId = value.elementId;
  if (elementId !== undefined && elementId !== null && typeof elementId !== 'string') {
    throw new ApiError('validation_failed', 'position.elementId must be text or null.');
  }

  const path = value.path;
  if (path !== undefined && path !== null && typeof path !== 'string') {
    throw new ApiError('validation_failed', 'position.path must be text or null.');
  }

  // What the reader had highlighted inside the element. Optional: an agent
  // pointing at an id has nothing highlighted, and the element's own words are
  // quoted instead.
  const snippet = value.snippet;
  if (snippet !== undefined && snippet !== null && typeof snippet !== 'string') {
    throw new ApiError('validation_failed', 'position.snippet must be text.');
  }

  return {
    elementId: (elementId as string | null | undefined) ?? null,
    path: (path as string | null | undefined) ?? null,
    snippet: (snippet as string | null | undefined) ?? null,
  };
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await request.json();
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new ApiError('validation_failed', 'The request body must be a JSON object.');
  }
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string') {
    throw new ApiError('validation_failed', `${field} is required and must be text.`);
  }
  return value;
}
