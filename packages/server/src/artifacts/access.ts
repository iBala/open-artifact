/**
 * Who may do what to an artifact.
 *
 * One function answers this for the whole product. Every route, every view, the
 * CLI and the skill all come through here. Scattering "is this the owner?" checks
 * across handlers is how one of them ends up missing.
 *
 * Sprint 2 knows about owners only. Sharing by email, by domain and publicly
 * arrives in Sprint 4 and extends this function rather than going around it.
 */

import type { UserRow } from '../db/schema.js';
import { notFound } from '../errors.js';

/** What someone is trying to do. */
export type ArtifactAction =
  /** Read the artifact and its content. */
  | 'view'
  /** Add or reply to comments on it. */
  | 'comment'
  /** Change the content, the sharing, or delete it. Owner only, always. */
  | 'manage';

/** Whoever is asking. Null means nobody is signed in. */
export type Principal = UserRow | null;

/** Anything with an owner: a database row or the shape the API returns. */
export interface OwnedArtifact {
  ownerId: string;
}

export function canAccess(
  principal: Principal,
  artifact: OwnedArtifact,
  action: ArtifactAction,
): boolean {
  // A deleted account keeps nothing.
  if (principal?.deletedAt) return false;

  if (principal !== null && principal.id === artifact.ownerId) return true;

  switch (action) {
    case 'manage':
      // Never anyone but the owner. Sprint 4 does not change this.
      return false;
    case 'view':
    case 'comment':
      // Sharing lands in Sprint 4. Until then, private means private.
      return false;
  }
}

/**
 * Throws unless the action is allowed.
 *
 * The refusal is always "no such artifact", never "you are not allowed to see
 * this one". Saying an artifact exists but is not yours confirms it exists, which
 * is exactly what a private artifact must not do. Anyone holding an artifact id
 * they were never given gets the same answer as if they had invented it.
 */
export function requireAccess(
  principal: Principal,
  artifact: OwnedArtifact,
  action: ArtifactAction,
): void {
  if (!canAccess(principal, artifact, action)) throw notFound();
}
