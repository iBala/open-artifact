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
import {
  anchorForElement,
  relocateElement,
  type ElementAnchor,
} from './html-source.js';

/**
 * Where a comment is being attached, as the caller describes it.
 *
 * Which half applies is decided by the artifact's format rather than by the
 * shape of what arrived, so a Markdown position on an HTML document is refused
 * plainly instead of being half-understood.
 */
export type CommentPosition =
  /** Markdown: the passage the reader selected. */
  | { headingId?: string | null; snippet: string; occurrence: number }
  /** HTML: the element they selected, and what they had highlighted inside it. */
  | { elementId?: string | null; path?: string | null; snippet?: string | null };

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
  /**
   * True when an element's id held but the words under it changed. The thread
   * kept its place; what it is about may have moved underneath it.
   */
  anchorDrifted: boolean;
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
    position?: CommentPosition | undefined;
  }): ThreadView {
    const body = requireBody(input.body);
    const anchor = this.resolveAnchor(input.artifact, input.position);
    const timestamp = nowIso();

    const thread: CommentThreadRow = {
      id: newId('thr'),
      artifactId: input.artifact.id,
      status: 'open',
      ...columnsFor(anchor),
      anchorLost: 0,
      anchorDrifted: 0,
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
    position: CommentPosition | undefined,
  ): Anchor {
    if (!position) return DOCUMENT_ANCHOR;

    // Which half of the position applies is decided by the document, not by what
    // arrived. An HTML artifact resolves an element against its source; a
    // Markdown one matches the passage the reader selected.
    if (artifact.type !== 'markdown') {
      return this.resolveElementAnchor(artifact.content, position);
    }

    if (!('snippet' in position) || typeof position.snippet !== 'string') {
      throw new ApiError(
        'validation_failed',
        'A comment on a passage of a Markdown document needs the text that was selected.',
      );
    }

    const passage = position as { headingId?: string | null; snippet: string; occurrence?: number };
    const occurrence = passage.occurrence ?? 0;

    const built =
      passage.headingId === undefined
        ? anchorAnywhere(artifact.content, passage.snippet, occurrence)
        : anchorForOccurrence(artifact.content, passage.headingId, passage.snippet, occurrence);

    if (!built.ok) {
      throw new ApiError('validation_failed', explainAnchorProblem(built.reason));
    }
    return built.anchor;
  }

  private resolveElementAnchor(html: string, position: CommentPosition): ElementAnchor {
    const elementId = 'elementId' in position ? position.elementId : undefined;
    const path = 'path' in position ? position.path : undefined;

    if (!elementId && !path) {
      throw new ApiError(
        'validation_failed',
        'A comment on part of an HTML artifact needs the element it is about, as elementId or path. Leave the position out entirely for a comment on the whole document.',
      );
    }

    const built = anchorForElement(html, {
      elementId,
      path,
      snippet: 'snippet' in position ? position.snippet : undefined,
    });

    if (!built.ok) {
      throw new ApiError('validation_failed', explainElementProblem(built.reason));
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
    // Every positioned thread, including ones already marked lost. Losing a
    // place must not be one-way: an agent that drops an id in one version and
    // restores it in the next should get the thread back, and it only can if we
    // keep looking for it.
    const positioned = this.db
      .select()
      .from(commentThreads)
      .where(
        and(
          eq(commentThreads.artifactId, artifactId),
          inArray(commentThreads.anchorKind, ['text', 'element']),
        ),
      )
      .all();

    let lostCount = 0;

    for (const thread of positioned) {
      const outcome = this.relocateOne(thread, newContent, artifactType);
      if (!outcome.found) lostCount += 1;

      const wasLost = thread.anchorLost === 1;
      const wasDrifted = thread.anchorDrifted === 1;
      const nowLost = !outcome.found;
      const nowDrifted = outcome.found && outcome.drifted;

      // Only write when something actually changed. Most threads on most
      // re-publishes are untouched, and a write per thread per version would
      // make a busy document expensive for no reason.
      if (wasLost === nowLost && wasDrifted === nowDrifted && !outcome.refreshed) continue;

      this.db
        .update(commentThreads)
        .set({
          anchorLost: nowLost ? 1 : 0,
          anchorDrifted: nowDrifted ? 1 : 0,
          ...(outcome.refreshed ?? {}),
        })
        .where(eq(commentThreads.id, thread.id))
        .run();
    }

    return lostCount;
  }

  /**
   * One thread against one new version of the document.
   *
   * A thread whose kind does not match the document is lost outright: an agent
   * can change an artifact from HTML to Markdown, and an element anchor on a
   * Markdown document points at nothing. It stays lost rather than being
   * deleted, so switching the format back brings it home.
   */
  private relocateOne(
    thread: CommentThreadRow,
    newContent: string,
    artifactType: string,
  ): { found: boolean; drifted: boolean; refreshed?: Partial<CommentThreadRow> } {
    if (thread.anchorKind === 'text') {
      if (artifactType !== 'markdown') return { found: false, drifted: false };

      const anchor: TextAnchor = {
        kind: 'text',
        headingId: thread.anchorHeadingId,
        snippet: thread.anchorSnippet ?? '',
        occurrence: thread.anchorOccurrence ?? 0,
      };
      return { found: relocate(newContent, anchor).found, drifted: false };
    }

    if (artifactType === 'markdown') return { found: false, drifted: false };

    const anchor: ElementAnchor = {
      kind: 'element',
      elementId: thread.anchorElementId,
      path: thread.anchorElementPath ?? '',
      tag: thread.anchorElementTag ?? '',
      text: thread.anchorElementText ?? '',
      snippet: thread.anchorSnippet ?? '',
    };

    const moved = relocateElement(newContent, anchor);
    if (!moved.found) return { found: false, drifted: false };

    // The element's words are refreshed every time the id match holds, so a
    // version that later drops the id can still be matched by path against what
    // the element says now rather than what it said when the comment was written.
    return {
      found: true,
      drifted: moved.drifted,
      refreshed: {
        anchorElementPath: moved.anchor.path,
        anchorElementTag: moved.anchor.tag,
        anchorElementText: moved.anchor.text,
      },
    };
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
      anchor: anchorFrom(row),
      anchorLost: row.anchorLost === 1,
      anchorDrifted: row.anchorDrifted === 1,
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

function explainElementProblem(
  reason: 'not-found' | 'no-source-position' | 'repeated-id' | 'too-little-text',
): string {
  switch (reason) {
    case 'not-found':
      return 'That element is not in the artifact as it stands now. Read it again and point at something in the current version.';
    case 'no-source-position':
      return 'That element was added by the parser rather than written in the page, so there is nothing in the source to point at. Pick the element around it.';
    case 'repeated-id':
      return 'The page uses that id more than once, so it does not say which element you mean. Point at it by path instead.';
    case 'too-little-text':
      return 'That element has no id and almost no text, so a comment on it could not be found again after an edit. Give it an id, or comment on the block around it.';
  }
}

/**
 * The anchor columns for a thread, from the anchor it was given.
 *
 * One place, so a new anchor kind cannot half-land: forgetting a column here is
 * a type error rather than a row that reads as a document comment.
 */
function columnsFor(anchor: Anchor): Pick<
  CommentThreadRow,
  | 'anchorKind'
  | 'anchorHeadingId'
  | 'anchorSnippet'
  | 'anchorOccurrence'
  | 'anchorElementId'
  | 'anchorElementPath'
  | 'anchorElementTag'
  | 'anchorElementText'
> {
  const empty = {
    anchorHeadingId: null,
    anchorSnippet: null,
    anchorOccurrence: null,
    anchorElementId: null,
    anchorElementPath: null,
    anchorElementTag: null,
    anchorElementText: null,
  };

  if (anchor.kind === 'text') {
    return {
      ...empty,
      anchorKind: 'text',
      anchorHeadingId: anchor.headingId,
      anchorSnippet: anchor.snippet,
      anchorOccurrence: anchor.occurrence,
    };
  }

  if (anchor.kind === 'element') {
    return {
      ...empty,
      anchorKind: 'element',
      // What the reader selected, kept for people and for clients that shipped
      // before element anchors existed and read this field for any anchor that
      // is not a document anchor.
      anchorSnippet: anchor.snippet,
      anchorElementId: anchor.elementId,
      anchorElementPath: anchor.path,
      anchorElementTag: anchor.tag,
      anchorElementText: anchor.text,
    };
  }

  return { ...empty, anchorKind: 'document' };
}

/** The anchor a stored row describes. */
function anchorFrom(row: CommentThreadRow): Anchor {
  if (row.anchorKind === 'text') {
    return {
      kind: 'text',
      headingId: row.anchorHeadingId,
      snippet: row.anchorSnippet ?? '',
      occurrence: row.anchorOccurrence ?? 0,
    };
  }

  if (row.anchorKind === 'element') {
    return {
      kind: 'element',
      elementId: row.anchorElementId,
      path: row.anchorElementPath ?? '',
      tag: row.anchorElementTag ?? '',
      text: row.anchorElementText ?? '',
      snippet: row.anchorSnippet ?? '',
    };
  }

  return DOCUMENT_ANCHOR;
}

function isString(value: string | null): value is string {
  return value !== null;
}

/** Re-exported so callers do not need to reach into the anchor module. */
export { gt };
