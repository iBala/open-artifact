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

export function registerCommentRoutes(app: Hono<AppEnv>, context: AppContext): void {
  const { artifacts, sharing, comments } = context;

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

    return c.json(
      comments.startThread({
        artifact,
        author: currentUser(c),
        body: requireString(body, 'body'),
        position: readPosition(body),
      }),
      201,
    );
  });

  /** Reply on a thread. */
  app.post('/api/comments/threads/:threadId/replies', requireUser, async (c) => {
    const threadId = c.req.param('threadId');
    artifactFor(comments.artifactIdFor(threadId), 'comment', c);

    const body = await readJson(c.req.raw);
    return c.json(comments.reply(threadId, currentUser(c), requireString(body, 'body')), 201);
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
