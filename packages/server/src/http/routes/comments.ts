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
import type { ThreadStatus } from '../../comments/service.js';
import { mentionEmail } from '../../mail/templates.js';
import { instanceNameFrom } from './auth.js';

export function registerCommentRoutes(app: Hono<AppEnv>, context: AppContext): void {
  const { artifacts, sharing, comments, notifications, config, mailer } = context;

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

  /** Start a thread, about a passage or about the whole document. */
  app.post('/api/artifacts/:id/comments', requireUser, async (c) => {
    const artifact = artifactFor(c.req.param('id'), 'comment', c);
    const body = await readJson(c.req.raw);

    const author = currentUser(c);
    const thread = comments.startThread({
      artifact,
      author,
      body: requireString(body, 'body'),
      position: readPosition(body),
    });

    const first = thread.comments[0];
    if (first) {
      const outcome = notifications.recordMentions({
        comment: { id: first.id, body: first.body, threadId: thread.id },
        artifact,
        author,
        candidates: notifications.mentionCandidates(
          artifact.id,
          sharing.accessFactsFor(artifact).sharedEmails,
        ),
        canGrantAccess: author.id === artifact.ownerId,
      });

      await emailMentions({
        outcome,
        artifact,
        author,
        threadId: thread.id,
        body: first.body,
      });
    }

    return c.json(thread, 201);
  });

  /** Reply on a thread. */
  app.post('/api/comments/threads/:threadId/replies', requireUser, async (c) => {
    const threadId = c.req.param('threadId');
    const artifact = artifactFor(comments.artifactIdFor(threadId), 'comment', c);
    const author = currentUser(c);
    const body = await readJson(c.req.raw);

    const reply = comments.reply(threadId, author, requireString(body, 'body'));

    const outcome = notifications.recordMentions({
      comment: { id: reply.id, body: reply.body, threadId },
      artifact,
      author,
      candidates: notifications.mentionCandidates(
        artifact.id,
        sharing.accessFactsFor(artifact).sharedEmails,
      ),
      canGrantAccess: author.id === artifact.ownerId,
    });

    notifications.notifyReply({
      comment: { id: reply.id, threadId },
      artifact,
      author,
      participantIds: comments.participantsOn(threadId),
    });

    await emailMentions({ outcome, artifact, author, threadId, body: reply.body });

    return c.json(reply, 201);
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

/** The optional position a comment is attached to. */
function readPosition(
  body: Record<string, unknown>,
): { headingId?: string | null; snippet: string; occurrence: number } | undefined {
  const position = body.position;
  if (position === undefined || position === null) return undefined;

  if (typeof position !== 'object' || Array.isArray(position)) {
    throw new ApiError('validation_failed', 'position must be an object, or left out entirely.');
  }

  const value = position as Record<string, unknown>;
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
