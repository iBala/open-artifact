/**
 * Telling people things happened.
 *
 * One row per person per event. Marking one read never touches anybody else's,
 * and somebody who gains access later never sees a backlog of things that
 * happened before they could have cared.
 *
 * The rule worth understanding before reading the code is what happens when
 * somebody is named who cannot see the artifact:
 *
 *   The owner names an outsider. The owner can grant access, so they are asked
 *   to, in one step, and the mention is delivered once they do.
 *
 *   Somebody else names an outsider. They cannot grant access, so the owner is
 *   asked instead, and the mention notification is held rather than sent. Telling
 *   somebody they were mentioned on a document they cannot open is pointing at a
 *   door and not giving them the key.
 *
 * Nothing here throws into the request that triggered it. Losing a notification
 * is worse than losing nothing, but it is not a reason to also lose the comment
 * somebody just wrote.
 */

import { eq, and, isNull, desc, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import {
  notifications,
  commentMentions,
  accessRequests,
  users,
  artifacts,
  comments,
  commentThreads,
  type NotificationRow,
  type UserRow,
} from '../db/schema.js';
import { newId } from '../ids.js';
import { nowIso } from '../time.js';
import { normaliseEmail } from '../auth/email-address.js';
import { mentionedAddresses, type MentionCandidate } from './mentions.js';

export type NotificationType = 'share' | 'mention' | 'reply' | 'access-request';

export interface NotificationView {
  id: string;
  type: NotificationType;
  createdAt: string;
  read: boolean;
  actor: { email: string; displayName: string | null } | null;
  artifact: { id: string; slug: string; title: string } | null;
  threadId: string | null;
  commentId: string | null;
  /** A short line of what happened, so the bell does not have to reconstruct it. */
  summary: string;
}

export interface MentionOutcome {
  /** Addresses that were named and can already see the artifact. */
  notified: string[];
  /** Addresses named who cannot see it, and whose mention is waiting on the owner. */
  awaitingAccess: string[];
}

export class NotificationService {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  // ---------------------------------------------------------------------------
  // Who can be named
  // ---------------------------------------------------------------------------

  /**
   * The people who may be mentioned on an artifact: whoever it is shared with,
   * plus anybody who has already commented, plus its owner.
   */
  mentionCandidates(artifactId: string, sharedEmails: string[]): MentionCandidate[] {
    const artifact = this.db.select().from(artifacts).where(eq(artifacts.id, artifactId)).get();
    if (!artifact) return [];

    const commenterIds = this.db
      .select({ authorId: comments.authorId })
      .from(comments)
      .innerJoin(commentThreads, eq(comments.threadId, commentThreads.id))
      .where(eq(commentThreads.artifactId, artifactId))
      .all()
      .map((row) => row.authorId)
      .filter((id): id is string => id !== null);

    const ids = [...new Set([artifact.ownerId, ...commenterIds])];
    const byId = ids.length
      ? this.db.select().from(users).where(inArray(users.id, ids)).all()
      : [];

    const candidates = new Map<string, MentionCandidate>();

    for (const user of byId) {
      if (user.deletedAt) continue;
      candidates.set(user.email, {
        email: user.email,
        displayName: user.displayName,
        userId: user.id,
        hasAccess: true,
      });
    }

    for (const email of sharedEmails) {
      if (candidates.has(email)) continue;
      const account = this.db.select().from(users).where(eq(users.email, email)).get();
      candidates.set(email, {
        email,
        displayName: account?.displayName ?? null,
        userId: account?.id ?? null,
        hasAccess: true,
      });
    }

    return [...candidates.values()].sort((a, b) => a.email.localeCompare(b.email));
  }

  // ---------------------------------------------------------------------------
  // A comment was written
  // ---------------------------------------------------------------------------

  /**
   * Records who a comment named, and tells them, or asks the owner to let them in.
   *
   * `canGrantAccess` is true when the person writing owns the artifact. It is the
   * whole difference between "here is a share to confirm" and "somebody would
   * like this person added".
   */
  recordMentions(input: {
    comment: { id: string; body: string; threadId: string };
    artifact: { id: string; ownerId: string };
    author: UserRow;
    /** Everybody who may be named here, with whether they can already see it. */
    candidates: MentionCandidate[];
    canGrantAccess: boolean;
  }): MentionOutcome {
    const named = mentionedAddresses(input.comment.body);
    const outcome: MentionOutcome = { notified: [], awaitingAccess: [] };

    for (const address of named) {
      // Only somebody who could be named here. An address typed at random is
      // just text, not a way to make the server email a stranger.
      const candidate = input.candidates.find((entry) => entry.email === address);
      const knownUser = this.db.select().from(users).where(eq(users.email, address)).get();

      const isCandidate = candidate !== undefined;
      const isOutsider = !isCandidate;

      // Naming yourself is not a notification.
      if (address === input.author.email) continue;

      this.db
        .insert(commentMentions)
        .values({
          id: newId('mnt'),
          commentId: input.comment.id,
          email: address,
          userId: knownUser?.id ?? null,
        })
        .run();

      if (isCandidate) {
        // Somebody who can see the artifact. If they have an account it goes on
        // their bell; either way they get the email, because being shared
        // something and not yet having signed in is the ordinary case here and
        // an email is exactly how they find out about it.
        if (knownUser && !knownUser.deletedAt) {
          this.notify({
            userId: knownUser.id,
            type: 'mention',
            actorUserId: input.author.id,
            artifactId: input.artifact.id,
            threadId: input.comment.threadId,
            commentId: input.comment.id,
            held: false,
          });
        }
        outcome.notified.push(address);
        continue;
      }

      if (isOutsider) {
        // They cannot see the artifact. Either way the owner decides; the only
        // question is whether the mention waits.
        this.db
          .insert(accessRequests)
          .values({
            id: newId('req'),
            artifactId: input.artifact.id,
            email: address,
            requestedByUserId: input.author.id,
            commentId: input.comment.id,
            createdAt: nowIso(),
            decidedAt: null,
            granted: null,
          })
          .run();

        this.notify({
          userId: input.artifact.ownerId,
          type: 'access-request',
          actorUserId: input.author.id,
          artifactId: input.artifact.id,
          threadId: input.comment.threadId,
          commentId: input.comment.id,
          held: false,
        });

        // Held, not sent. Pointing somebody at a document they cannot open is
        // worse than saying nothing until they can.
        if (knownUser && !knownUser.deletedAt) {
          this.notify({
            userId: knownUser.id,
            type: 'mention',
            actorUserId: input.author.id,
            artifactId: input.artifact.id,
            threadId: input.comment.threadId,
            commentId: input.comment.id,
            held: true,
          });
        }

        outcome.awaitingAccess.push(address);
      }
    }

    return outcome;
  }

  /** Tells everybody already on a thread that somebody replied. */
  notifyReply(input: {
    comment: { id: string; threadId: string };
    artifact: { id: string };
    author: UserRow;
    /** Everybody who has said something on this thread. */
    participantIds: string[];
  }): void {
    const mentioned = new Set(
      this.db
        .select()
        .from(commentMentions)
        .where(eq(commentMentions.commentId, input.comment.id))
        .all()
        .map((mention) => mention.userId),
    );

    for (const userId of new Set(input.participantIds)) {
      // Not yourself, and not twice for the same comment when you were also
      // named in it: the mention is the more specific thing to be told.
      if (userId === input.author.id) continue;
      if (mentioned.has(userId)) continue;

      this.notify({
        userId,
        type: 'reply',
        actorUserId: input.author.id,
        artifactId: input.artifact.id,
        threadId: input.comment.threadId,
        commentId: input.comment.id,
        held: false,
      });
    }
  }

  /** Tells somebody an artifact was shared with them. */
  notifyShare(input: {
    recipientUserId: string;
    actor: UserRow;
    artifactId: string;
  }): void {
    this.notify({
      userId: input.recipientUserId,
      type: 'share',
      actorUserId: input.actor.id,
      artifactId: input.artifactId,
      threadId: null,
      commentId: null,
      held: false,
    });
  }

  // ---------------------------------------------------------------------------
  // Access requests
  // ---------------------------------------------------------------------------

  /** Everything waiting on this owner, across their artifacts. */
  pendingRequestsFor(ownerId: string) {
    return this.db
      .select()
      .from(accessRequests)
      .innerJoin(artifacts, eq(accessRequests.artifactId, artifacts.id))
      .where(and(eq(artifacts.ownerId, ownerId), isNull(accessRequests.decidedAt)))
      .all()
      .map((row) => row.access_requests);
  }

  /**
   * Answers a request. Granting releases every mention that was waiting on it,
   * which is the moment telling that person becomes useful rather than annoying.
   */
  decideRequest(requestId: string, granted: boolean): { email: string; artifactId: string } | null {
    const request = this.db
      .select()
      .from(accessRequests)
      .where(eq(accessRequests.id, requestId))
      .get();
    if (!request || request.decidedAt !== null) return null;

    this.db
      .update(accessRequests)
      .set({ decidedAt: nowIso(), granted: granted ? 1 : 0 })
      .where(eq(accessRequests.id, requestId))
      .run();

    if (granted) this.releaseHeldFor(request.email, request.artifactId);

    return { email: request.email, artifactId: request.artifactId };
  }

  /**
   * Releases mentions that were waiting for somebody to be let in.
   *
   * Also called when an artifact is shared with an address by any other route,
   * because the reason for holding was never the request, it was the lack of
   * access.
   */
  releaseHeldFor(email: string, artifactId: string): number {
    const address = normaliseEmail(email);
    const user = this.db.select().from(users).where(eq(users.email, address)).get();
    if (!user) return 0;

    const result = this.db
      .update(notifications)
      .set({ held: 0, createdAt: nowIso() })
      .where(
        and(
          eq(notifications.userId, user.id),
          eq(notifications.artifactId, artifactId),
          eq(notifications.held, 1),
        ),
      )
      .run();

    return result.changes;
  }

  // ---------------------------------------------------------------------------
  // Reading
  // ---------------------------------------------------------------------------

  /** Somebody's notifications, newest first. Held ones are not theirs to see yet. */
  list(userId: string, limit = 50): NotificationView[] {
    const rows = this.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, userId), eq(notifications.held, 0)))
      .orderBy(desc(notifications.createdAt))
      .limit(limit)
      .all();

    return rows.map((row) => this.view(row));
  }

  unreadCount(userId: string): number {
    const row = this.db.get<{ count: number }>(
      sql`select count(*) as count from notifications
          where user_id = ${userId} and read_at is null and held = 0`,
    );
    return row?.count ?? 0;
  }

  markRead(userId: string, notificationId: string): boolean {
    const result = this.db
      .update(notifications)
      .set({ readAt: nowIso() })
      .where(
        and(
          eq(notifications.id, notificationId),
          eq(notifications.userId, userId),
          isNull(notifications.readAt),
        ),
      )
      .run();
    return result.changes > 0;
  }

  markAllRead(userId: string): number {
    return this.db
      .update(notifications)
      .set({ readAt: nowIso() })
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
      .run().changes;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private notify(input: {
    userId: string;
    type: NotificationType;
    actorUserId: string | null;
    artifactId: string | null;
    threadId: string | null;
    commentId: string | null;
    held: boolean;
  }): void {
    this.db
      .insert(notifications)
      .values({
        id: newId('ntf'),
        userId: input.userId,
        type: input.type,
        actorUserId: input.actorUserId,
        artifactId: input.artifactId,
        threadId: input.threadId,
        commentId: input.commentId,
        createdAt: nowIso(),
        readAt: null,
        held: input.held ? 1 : 0,
      })
      .run();
  }

  private view(row: NotificationRow): NotificationView {
    const actor = row.actorUserId
      ? this.db.select().from(users).where(eq(users.id, row.actorUserId)).get()
      : undefined;
    const artifact = row.artifactId
      ? this.db.select().from(artifacts).where(eq(artifacts.id, row.artifactId)).get()
      : undefined;

    const who = actor && !actor.deletedAt ? (actor.displayName ?? actor.email) : 'Somebody';
    const what = artifact?.title ?? 'an artifact';

    return {
      id: row.id,
      type: row.type as NotificationType,
      createdAt: row.createdAt,
      read: row.readAt !== null,
      actor:
        actor && !actor.deletedAt
          ? { email: actor.email, displayName: actor.displayName }
          : null,
      artifact: artifact
        ? { id: artifact.id, slug: artifact.slug, title: artifact.title }
        : null,
      threadId: row.threadId,
      commentId: row.commentId,
      summary: summarise(row.type as NotificationType, who, what),
    };
  }
}

function summarise(type: NotificationType, who: string, what: string): string {
  switch (type) {
    case 'share':
      return `${who} shared ${what} with you`;
    case 'mention':
      return `${who} mentioned you on ${what}`;
    case 'reply':
      return `${who} replied on ${what}`;
    case 'access-request':
      return `${who} wants to add somebody to ${what}`;
  }
}
