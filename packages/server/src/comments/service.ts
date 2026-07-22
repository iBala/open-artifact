/**
 * Comments.
 *
 * A thread is a place in an artifact; the comments on it are what people said
 * there. There is exactly one level of nesting, and it is structural rather than
 * a rule: a reply is another comment on the same thread, and there is nowhere
 * for a reply to a reply to go.
 *
 * Who can do what:
 *
 *   comment   anybody the artifact is shared with, and the owner. Not a
 *             passer-by on a public artifact: reading is open to the world,
 *             a comment box open to the world is a different product.
 *   edit      the author of that comment, nobody else, ever.
 *   delete    the author, or the artifact's owner. An owner needs to be able to
 *             clear something off their own document.
 *   resolve   whoever started the thread, or the artifact's owner. The person
 *             who raised something and the person who owns the work are the two
 *             who can reasonably say it is settled.
 */

import { eq, and, desc, asc, gt, inArray } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import {
  commentThreads,
  comments,
  users,
  type CommentThreadRow,
  type CommentRow,
  type UserRow,
} from '../db/schema.js';
import { newId } from '../ids.js';
import { nowIso, parseIso } from '../time.js';
import { ApiError, notFound } from '../errors.js';
import {
  anchorForOccurrence,
  anchorAnywhere,
  relocate,
  DOCUMENT_ANCHOR,
  type Anchor,
  type TextAnchor,
} from './anchors.js';

/** The longest a single comment can be. Long enough for a paragraph of thought. */
export const MAX_COMMENT_LENGTH = 10_000;

/** What a deleted comment says in place of what it said. */
export const DELETED_PLACEHOLDER = 'This comment was deleted.';

/** What a comment by a closed account is attributed to. */
export const DELETED_AUTHOR = 'Deleted user';

export type ThreadStatus = 'open' | 'resolved';

export interface CommentView {
  id: string;
  threadId: string;
  author: { id: string; email: string; displayName: string | null } | null;
  body: string;
  createdAt: string;
  editedAt: string | null;
  /** True when the body is a placeholder rather than what was written. */
  deleted: boolean;
}

export interface ThreadView {
  id: string;
  artifactId: string;
  status: ThreadStatus;
  anchor: Anchor;
  /** True when a re-publish could no longer find the passage this was about. */
  anchorLost: boolean;
  createdAt: string;
  resolvedAt: string | null;
  comments: CommentView[];
}

export interface ListOptions {
  /** Only threads with activity after this UTC ISO-8601 timestamp. */
  since?: string | undefined;
  status?: ThreadStatus | undefined;
}

export class CommentService {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  // ---------------------------------------------------------------------------
  // Starting a conversation
  // ---------------------------------------------------------------------------

  /**
   * Starts a thread and posts its first comment.
   *
   * The anchor is worked out here from the artifact's own content, never taken
   * on trust from the caller. A client that could name its own anchor could
   * attach a comment to text that was never there.
   */
  startThread(input: {
    artifact: { id: string; type: string; content: string };
    author: UserRow;
    body: string;
    /**
     * Leave out entirely for a comment about the artifact as a whole.
     *
     * Within it, leave the heading out and the passage is looked for across the
     * whole document. Pass null for one that sits before the first heading.
     */
    position?:
      | { headingId?: string | null; snippet: string; occurrence: number }
      | undefined;
  }): ThreadView {
    const body = requireBody(input.body);
    const anchor = this.resolveAnchor(input.artifact, input.position);
    const timestamp = nowIso();

    const thread: CommentThreadRow = {
      id: newId('thr'),
      artifactId: input.artifact.id,
      status: 'open',
      anchorKind: anchor.kind,
      anchorHeadingId: anchor.kind === 'text' ? anchor.headingId : null,
      anchorSnippet: anchor.kind === 'text' ? anchor.snippet : null,
      anchorOccurrence: anchor.kind === 'text' ? anchor.occurrence : null,
      anchorLost: 0,
      createdAt: timestamp,
      createdByUserId: input.author.id,
      resolvedAt: null,
      resolvedByUserId: null,
    };

    this.db.transaction((tx) => {
      tx.insert(commentThreads).values(thread).run();
      tx.insert(comments)
        .values({
          id: newId('cmt'),
          threadId: thread.id,
          authorId: input.author.id,
          body,
          createdAt: timestamp,
          editedAt: null,
          deletedAt: null,
        })
        .run();
    });

    return this.threadView(thread.id);
  }

  private resolveAnchor(
    artifact: { type: string; content: string },
    position: { headingId?: string | null; snippet: string; occurrence: number } | undefined,
  ): Anchor {
    if (!position) return DOCUMENT_ANCHOR;

    // An HTML artifact runs in a sandboxed frame we deliberately cannot reach
    // into, so there is no way to know what was selected or to find it again.
    // Those get document-level comments only.
    if (artifact.type !== 'markdown') {
      throw new ApiError(
        'validation_failed',
        'Comments on an HTML artifact are about the whole document. Only Markdown artifacts can be commented on at a position.',
      );
    }

    const built =
      position.headingId === undefined
        ? anchorAnywhere(artifact.content, position.snippet, position.occurrence)
        : anchorForOccurrence(
            artifact.content,
            position.headingId,
            position.snippet,
            position.occurrence,
          );

    if (!built.ok) {
      throw new ApiError('validation_failed', explainAnchorProblem(built.reason));
    }
    return built.anchor;
  }

  reply(threadId: string, author: UserRow, rawBody: string): CommentView {
    const thread = this.requireThread(threadId);
    const body = requireBody(rawBody);

    const comment: CommentRow = {
      id: newId('cmt'),
      threadId: thread.id,
      authorId: author.id,
      body,
      createdAt: nowIso(),
      editedAt: null,
      deletedAt: null,
    };
    this.db.insert(comments).values(comment).run();

    return this.commentView(comment, author);
  }

  // ---------------------------------------------------------------------------
  // Changing what was said
  // ---------------------------------------------------------------------------

  edit(commentId: string, actor: UserRow, rawBody: string): CommentView {
    const comment = this.requireComment(commentId);

    // Only the author, whoever else is asking. Editing somebody else's words is
    // not a thing this product does, not even for the artifact's owner.
    if (comment.authorId !== actor.id) throw notFound('comment');
    if (comment.deletedAt !== null) {
      throw new ApiError('validation_failed', 'That comment was deleted.');
    }

    const body = requireBody(rawBody);
    const editedAt = nowIso();

    this.db.update(comments).set({ body, editedAt }).where(eq(comments.id, commentId)).run();

    return this.commentView({ ...comment, body, editedAt }, actor);
  }

  /**
   * Deletes a comment.
   *
   * The row survives when replies came after it, so the conversation keeps its
   * shape and a reply never becomes an answer to nothing. When nothing followed
   * it, and it was the only thing on the thread, the thread goes too.
   */
  delete(commentId: string, actor: UserRow, artifactOwnerId: string): { threadDeleted: boolean } {
    const comment = this.requireComment(commentId);

    const isAuthor = comment.authorId === actor.id;
    const isArtifactOwner = actor.id === artifactOwnerId;
    if (!isAuthor && !isArtifactOwner) throw notFound('comment');

    const onThread = this.commentsOn(comment.threadId);
    const isOnlyComment = onThread.length === 1;

    if (isOnlyComment) {
      // Nothing is left to keep the shape of, so take the thread with it rather
      // than leaving a placeholder nobody can reply to usefully.
      this.db.delete(commentThreads).where(eq(commentThreads.id, comment.threadId)).run();
      return { threadDeleted: true };
    }

    this.db.update(comments).set({ deletedAt: nowIso() }).where(eq(comments.id, commentId)).run();
    return { threadDeleted: false };
  }

  // ---------------------------------------------------------------------------
  // Settling it
  // ---------------------------------------------------------------------------

  setStatus(
    threadId: string,
    actor: UserRow,
    artifactOwnerId: string,
    status: ThreadStatus,
  ): ThreadView {
    const thread = this.requireThread(threadId);

    const startedIt = thread.createdByUserId === actor.id;
    const ownsTheArtifact = actor.id === artifactOwnerId;
    if (!startedIt && !ownsTheArtifact) {
      throw new ApiError(
        'forbidden',
        'Only the person who started this thread, or whoever owns the artifact, can settle it.',
      );
    }

    this.db
      .update(commentThreads)
      .set({
        status,
        resolvedAt: status === 'resolved' ? nowIso() : null,
        resolvedByUserId: status === 'resolved' ? actor.id : null,
      })
      .where(eq(commentThreads.id, threadId))
      .run();

    return this.threadView(threadId);
  }

  // ---------------------------------------------------------------------------
  // Reading
  // ---------------------------------------------------------------------------

  /**
   * Threads on an artifact, newest first, replies within each oldest first.
   *
   * `since` is what makes the agent loop work: an agent asks for everything that
   * has happened since it last looked, rather than re-reading the lot. It matches
   * on the newest comment in the thread, not the thread's own creation time, so
   * a reply to an old thread still shows up.
   */
  list(artifactId: string, options: ListOptions = {}): ThreadView[] {
    const since = options.since === undefined ? null : parseIso(options.since);
    if (options.since !== undefined && since === null) {
      throw new ApiError(
        'validation_failed',
        'since must be a UTC timestamp, for example 2026-07-22T09:41:07.000Z',
      );
    }

    if (options.status !== undefined && options.status !== 'open' && options.status !== 'resolved') {
      throw new ApiError('validation_failed', 'status must be "open" or "resolved".');
    }

    const rows = this.db
      .select()
      .from(commentThreads)
      .where(
        options.status
          ? and(
              eq(commentThreads.artifactId, artifactId),
              eq(commentThreads.status, options.status),
            )
          : eq(commentThreads.artifactId, artifactId),
      )
      .orderBy(desc(commentThreads.createdAt))
      .all();

    return rows
      .map((row) => this.threadViewFrom(row))
      .filter((thread) => {
        if (since === null) return true;
        const newest = thread.comments.at(-1)?.createdAt ?? thread.createdAt;
        return newest > since;
      });
  }

  threadView(threadId: string): ThreadView {
    return this.threadViewFrom(this.requireThread(threadId));
  }

  /** Everybody who has said something on a thread, for telling them about a reply. */
  participantsOn(threadId: string): string[] {
    return [
      ...new Set(
        this.commentsOn(threadId)
          .map((comment) => comment.authorId)
          .filter((id): id is string => id !== null),
      ),
    ];
  }

  /** The artifact a thread belongs to, so callers can check access against it. */
  artifactIdFor(threadId: string): string {
    return this.requireThread(threadId).artifactId;
  }

  artifactIdForComment(commentId: string): string {
    return this.requireThread(this.requireComment(commentId).threadId).artifactId;
  }

  // ---------------------------------------------------------------------------
  // Keeping up with the document
  // ---------------------------------------------------------------------------

  /**
   * Re-checks every anchored thread against new content, after a re-publish.
   *
   * Threads whose passage is still there are untouched. Threads whose passage is
   * gone become document-level and are marked as having lost their place, which
   * the UI says out loud. Nothing is ever moved to different text.
   *
   * Returns how many lost their place, for the log.
   */
  relocateAll(artifactId: string, newContent: string, artifactType: string): number {
    if (artifactType !== 'markdown') return 0;

    const anchored = this.db
      .select()
      .from(commentThreads)
      .where(
        and(eq(commentThreads.artifactId, artifactId), eq(commentThreads.anchorKind, 'text')),
      )
      .all();

    const lost = anchored.filter((thread) => {
      const anchor: TextAnchor = {
        kind: 'text',
        headingId: thread.anchorHeadingId,
        snippet: thread.anchorSnippet ?? '',
        occurrence: thread.anchorOccurrence ?? 0,
      };
      return !relocate(newContent, anchor).found;
    });

    if (lost.length > 0) {
      this.db
        .update(commentThreads)
        .set({
          anchorKind: 'document',
          anchorHeadingId: null,
          anchorSnippet: null,
          anchorOccurrence: null,
          anchorLost: 1,
        })
        .where(
          inArray(
            commentThreads.id,
            lost.map((thread) => thread.id),
          ),
        )
        .run();
    }

    return lost.length;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private requireThread(threadId: string): CommentThreadRow {
    const row = this.db
      .select()
      .from(commentThreads)
      .where(eq(commentThreads.id, threadId))
      .get();
    if (!row) throw notFound('comment thread');
    return row;
  }

  private requireComment(commentId: string): CommentRow {
    const row = this.db.select().from(comments).where(eq(comments.id, commentId)).get();
    if (!row) throw notFound('comment');
    return row;
  }

  private commentsOn(threadId: string): CommentRow[] {
    return this.db
      .select()
      .from(comments)
      .where(eq(comments.threadId, threadId))
      .orderBy(asc(comments.createdAt))
      .all();
  }

  private threadViewFrom(row: CommentThreadRow): ThreadView {
    const onThread = this.commentsOn(row.id);
    const authors = this.authorsOf(onThread);

    return {
      id: row.id,
      artifactId: row.artifactId,
      status: row.status as ThreadStatus,
      anchor:
        row.anchorKind === 'text'
          ? {
              kind: 'text',
              headingId: row.anchorHeadingId,
              snippet: row.anchorSnippet ?? '',
              occurrence: row.anchorOccurrence ?? 0,
            }
          : DOCUMENT_ANCHOR,
      anchorLost: row.anchorLost === 1,
      createdAt: row.createdAt,
      resolvedAt: row.resolvedAt,
      comments: onThread.map((comment) =>
        this.commentView(comment, comment.authorId ? authors.get(comment.authorId) : undefined),
      ),
    };
  }

  /** One lookup for every author on a thread, rather than one per comment. */
  private authorsOf(onThread: CommentRow[]): Map<string, UserRow> {
    const ids = [...new Set(onThread.map((comment) => comment.authorId).filter(isString))];
    if (ids.length === 0) return new Map();

    return new Map(
      this.db
        .select()
        .from(users)
        .where(inArray(users.id, ids))
        .all()
        .map((user) => [user.id, user]),
    );
  }

  private commentView(comment: CommentRow, author: UserRow | undefined): CommentView {
    const deleted = comment.deletedAt !== null;

    return {
      id: comment.id,
      threadId: comment.threadId,
      // A closed account keeps its place in the conversation without its name.
      author:
        author && !author.deletedAt
          ? { id: author.id, email: author.email, displayName: author.displayName }
          : null,
      // The body of a deleted comment is never served, not even to whoever
      // deleted it. There is no screen that should show it again.
      body: deleted ? DELETED_PLACEHOLDER : comment.body,
      createdAt: comment.createdAt,
      editedAt: comment.editedAt,
      deleted,
    };
  }
}

function requireBody(body: unknown): string {
  if (typeof body !== 'string' || body.trim().length === 0) {
    throw new ApiError('validation_failed', 'A comment needs something in it.');
  }
  if (body.length > MAX_COMMENT_LENGTH) {
    throw new ApiError(
      'validation_failed',
      `A comment can be up to ${MAX_COMMENT_LENGTH} characters. That one is ${body.length}.`,
    );
  }
  return body.trim();
}

function explainAnchorProblem(
  reason: 'too-short' | 'too-long' | 'not-found' | 'ambiguous',
): string {
  switch (reason) {
    case 'too-short':
      return 'Select a few more words. A very short passage appears too often to be found again after an edit.';
    case 'too-long':
      return 'That selection is too long to anchor to. Pick a sentence or two.';
    case 'not-found':
      return 'That passage is not in the artifact as it stands now. Read it again and quote from the current version.';
    case 'ambiguous':
      return 'That text appears under more than one heading, so it does not say which one you mean. Name the heading, or quote a longer passage that only appears once.';
  }
}

function isString(value: string | null): value is string {
  return value !== null;
}

/** Re-exported so callers do not need to reach into the anchor module. */
export { gt };
