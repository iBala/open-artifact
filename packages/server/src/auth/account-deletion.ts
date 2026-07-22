/**
 * Closing an account.
 *
 * This is deliberately not a hard delete of the person's row. Their comments on
 * other people's artifacts stay where they are, word for word, because taking
 * the words out would tear holes in conversations other people are still having.
 * A reply that answers a question would be left answering nothing.
 *
 * So the row survives with nothing identifying on it, and everything that
 * pointed at the person either goes or forgets who it was:
 *
 *   goes    their artifacts and everything hanging off them, their sessions and
 *           CLI tokens, their sign-in codes, their notifications, every share
 *           that named them, and every mention of them.
 *   forgets their comments and threads on other people's artifacts, and other
 *           people's notifications that they caused. Those keep their shape and
 *           lose the name.
 *
 * Everything happens in one transaction. A half-deleted account is worse than a
 * whole one: some of it would be gone and the person would still be signed in.
 */

import { eq, or } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import {
  users,
  authSessions,
  apiTokens,
  signInCodes,
  deviceCodes,
  artifacts,
  artifactShares,
  artifactDomainShares,
  commentThreads,
  comments,
  commentMentions,
  accessRequests,
  notifications,
} from '../db/schema.js';
import { nowIso } from '../time.js';
import { ApiError } from '../errors.js';

export interface AccountDeletionSummary {
  /** Artifacts removed, with their versions, shares, threads and comments. */
  artifactsDeleted: number;
  /** Comments on other people's artifacts that kept their body and lost their author. */
  commentsAnonymised: number;
}

/**
 * The address a closed account is left with.
 *
 * Three things it has to be, and this scheme is the smallest one that is all
 * three:
 *
 * - Unique, because users.email is unique and two people closing their accounts
 *   must not collide. The user id is already the unique thing about the row, so
 *   the address is built from it.
 * - Undeliverable, so no mail can ever reach it. `.invalid` is reserved by RFC
 *   2606 precisely for this: it is guaranteed never to resolve, anywhere.
 * - Impossible to sign in to. Asking for a sign-in code sends the digits to the
 *   address, and nobody can read mail at an address that cannot receive any.
 *
 * The id is lowercased because every address in this database is stored
 * lowercased and comparisons everywhere assume it. Two ids that differ only in
 * case would collide, which needs sixteen characters to match case-insensitively
 * by chance, so it will not happen.
 */
export function anonymisedEmailFor(userId: string): string {
  return `deleted-${userId.toLowerCase()}@deleted.invalid`;
}

/**
 * Closes an account. Returns what was removed, for the log.
 *
 * The caller must be the person themselves: there is no admin path to this, and
 * nothing here checks who is asking.
 */
export function deleteAccount(db: Db, userId: string): AccountDeletionSummary {
  const user = db.select().from(users).where(eq(users.id, userId)).get();
  if (!user || user.deletedAt !== null) {
    throw new ApiError('not_found', 'No such account.');
  }

  const email = user.email;
  const timestamp = nowIso();

  return db.transaction((tx) => {
    // Their own work first. The foreign keys take the rest with it: versions,
    // shares of both kinds, threads, comments, mentions, access requests, and
    // every notification that pointed at the artifact. Comments other people
    // left on their artifacts go too, because the document they were about is
    // gone and a comment about nothing is not a conversation.
    const artifactsDeleted = tx
      .delete(artifacts)
      .where(eq(artifacts.ownerId, userId))
      .run().changes;

    // Anything they could still sign in or act with. Deleted rather than
    // revoked: a revoked row still says which account it belonged to.
    tx.delete(authSessions).where(eq(authSessions.userId, userId)).run();
    tx.delete(apiTokens).where(eq(apiTokens.userId, userId)).run();
    // Sign-in codes are held against the address, not the account, so this has
    // to happen while we still know what the address was.
    tx.delete(signInCodes).where(eq(signInCodes.email, email)).run();
    // A command-line sign-in they approved, or one waiting on them.
    tx.delete(deviceCodes).where(eq(deviceCodes.approvedByUserId, userId)).run();

    // Access other people gave them, and invitations still waiting for their
    // address. Both by id and by address: a share to somebody who never signed
    // in has no account on it yet.
    tx
      .delete(artifactShares)
      .where(or(eq(artifactShares.userId, userId), eq(artifactShares.email, email)))
      .run();

    // Shares they created on somebody else's artifact. The share stays, because
    // taking it away would take somebody else's access with it; only the name of
    // who set it up goes.
    tx
      .update(artifactShares)
      .set({ createdByUserId: null })
      .where(eq(artifactShares.createdByUserId, userId))
      .run();
    tx
      .update(artifactDomainShares)
      .set({ createdByUserId: null })
      .where(eq(artifactDomainShares.createdByUserId, userId))
      .run();

    // Being named in somebody else's comment. The row is only there so the
    // mention can be resolved to an account and notified; the words that named
    // them are in the comment body and are not ours to edit. Deleting the row
    // means the mention resolves to nobody, which is what they asked for.
    tx
      .delete(commentMentions)
      .where(or(eq(commentMentions.userId, userId), eq(commentMentions.email, email)))
      .run();

    // A request that somebody be given access to their address is pointless now.
    tx.delete(accessRequests).where(eq(accessRequests.email, email)).run();
    // One they raised for somebody else still needs an answer from the owner, so
    // it stays and loses the name.
    tx
      .update(accessRequests)
      .set({ requestedByUserId: null })
      .where(eq(accessRequests.requestedByUserId, userId))
      .run();

    tx.delete(notifications).where(eq(notifications.userId, userId)).run();
    // Somebody else's notification that they caused. It stays in that person's
    // list, attributed to a deleted user, the same way the comment it is about
    // does.
    tx
      .update(notifications)
      .set({ actorUserId: null })
      .where(eq(notifications.actorUserId, userId))
      .run();

    // The point of the whole exercise: their words on other people's artifacts,
    // kept exactly as written, with the authorship gone.
    const commentsAnonymised = tx
      .update(comments)
      .set({ authorId: null })
      .where(eq(comments.authorId, userId))
      .run().changes;

    tx
      .update(commentThreads)
      .set({ createdByUserId: null })
      .where(eq(commentThreads.createdByUserId, userId))
      .run();
    tx
      .update(commentThreads)
      .set({ resolvedByUserId: null })
      .where(eq(commentThreads.resolvedByUserId, userId))
      .run();

    // Last, the person. The row lives on so the comments above have something to
    // point at, holding nothing that says who it was. emailVerified goes back to
    // 0 as well: the address on the row now is not one anybody proved they own.
    tx
      .update(users)
      .set({
        email: anonymisedEmailFor(userId),
        displayName: null,
        emailVerified: 0,
        deletedAt: timestamp,
        updatedAt: timestamp,
      })
      .where(eq(users.id, userId))
      .run();

    return { artifactsDeleted, commentsAnonymised };
  });
}
