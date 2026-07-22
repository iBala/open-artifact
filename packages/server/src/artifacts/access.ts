/**
 * Who may do what to an artifact.
 *
 * One function answers this for the whole product. Every route, the viewer, the
 * CLI and the skill come through here. Scattering "is this shared with them?"
 * checks across handlers is how one of them ends up missing, and the one that
 * ends up missing is the one that leaks.
 *
 * The rules, in full:
 *
 *   The owner can do anything.
 *   Somebody the artifact is shared with, by address or by their domain, can
 *     read it and comment on it.
 *   Anybody at all can read a public artifact.
 *   Nobody but the owner can ever change sharing, edit or delete.
 *
 * The one that surprises people: commenting on a public artifact needs an
 * explicit share. Public means the world can read it, and a comment box open to
 * the world is a different product with different problems.
 */

import type { UserRow } from '../db/schema.js';
import { notFound } from '../errors.js';
import { domainOf } from '../auth/email-address.js';

/** What somebody is trying to do. */
export type ArtifactAction =
  /** Read the artifact and its content. */
  | 'view'
  /** Add or reply to comments on it. */
  | 'comment'
  /** Change the content, the sharing, or delete it. Owner only, always. */
  | 'manage';

/** Whoever is asking. Null means nobody is signed in. */
export type Principal = UserRow | null;

/** What the artifact says about who can reach it. */
export interface ArtifactAccessFacts {
  ownerId: string;
  isPublic: boolean;
  /** Lowercased addresses this artifact is shared with. */
  sharedEmails: string[];
  /** Lowercased domains this artifact is shared with. */
  sharedDomains: string[];
}

export type AccessReason =
  | 'owner'
  | 'shared-with-you'
  | 'shared-with-your-domain'
  | 'public'
  | 'no-access';

/** Why somebody does or does not have access. Useful for tests and for the UI. */
export function accessReason(principal: Principal, artifact: ArtifactAccessFacts): AccessReason {
  // A deleted account keeps nothing.
  if (principal?.deletedAt) return 'no-access';

  if (principal && principal.id === artifact.ownerId) return 'owner';

  if (principal) {
    // Only a verified address counts. Otherwise somebody could claim an address
    // they do not own and walk into everything shared with it.
    const verified = principal.emailVerified === 1;
    const email = principal.email.toLowerCase();

    if (verified && artifact.sharedEmails.includes(email)) return 'shared-with-you';
    if (verified && artifact.sharedDomains.includes(domainOf(email))) {
      return 'shared-with-your-domain';
    }
  }

  if (artifact.isPublic) return 'public';

  return 'no-access';
}

export function canAccess(
  principal: Principal,
  artifact: ArtifactAccessFacts,
  action: ArtifactAction,
): boolean {
  const reason = accessReason(principal, artifact);

  switch (action) {
    case 'manage':
      return reason === 'owner';

    case 'view':
      return reason !== 'no-access';

    case 'comment':
      // Everything except a passer-by on a public artifact.
      return reason === 'owner' || reason === 'shared-with-you' || reason === 'shared-with-your-domain';
  }
}

/**
 * Throws unless the action is allowed.
 *
 * The refusal is always "no such artifact", never "you are not allowed to see
 * this one". Saying an artifact exists but is not yours confirms it exists,
 * which is exactly what a private artifact must not do. Anybody holding an id
 * they were never given gets the same answer as if they had invented it.
 */
export function requireAccess(
  principal: Principal,
  artifact: ArtifactAccessFacts,
  action: ArtifactAction,
): void {
  if (!canAccess(principal, artifact, action)) throw notFound();
}
