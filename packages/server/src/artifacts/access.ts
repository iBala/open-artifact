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
 *   Once the link expires, everybody but the owner loses all of the above.
 *
 * The one that surprises people: commenting on a public artifact needs an
 * explicit share. Public means the world can read it, and a comment box open to
 * the world is a different product with different problems.
 */

import type { UserRow } from '../db/schema.js';
import { isExpired } from '@open-artifact/shared';
import { notFound, linkExpired } from '../errors.js';
import { nowIso } from '../time.js';
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
  /** When everybody but the owner loses access. Null means never. */
  expiresAt: string | null;
}

export type AccessReason =
  | 'owner'
  | 'shared-with-you'
  | 'shared-with-your-domain'
  | 'public'
  | 'expired'
  | 'no-access';

/**
 * Why somebody does or does not have access. Useful for tests and for the UI.
 *
 * Expiry is applied last, and only to somebody who would otherwise have got in.
 * That ordering is the whole reason 'expired' is safe to tell people about:
 * somebody who never had access gets the same 'no-access' they always got,
 * expired link or not, so the answer never confirms that an artifact exists to
 * somebody who was never given it.
 */
export function accessReason(principal: Principal, artifact: ArtifactAccessFacts): AccessReason {
  const reason = reasonIgnoringExpiry(principal, artifact);

  // The owner is never locked out of their own document. Expiry withdraws a
  // link; it does not destroy what the link pointed at.
  if (reason === 'owner' || reason === 'no-access') return reason;

  return isExpired(artifact.expiresAt, nowIso()) ? 'expired' : reason;
}

function reasonIgnoringExpiry(principal: Principal, artifact: ArtifactAccessFacts): AccessReason {
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
      return reason !== 'no-access' && reason !== 'expired';

    case 'comment':
      // Everything except a passer-by on a public artifact.
      return reason === 'owner' || reason === 'shared-with-you' || reason === 'shared-with-your-domain';
  }
}

/**
 * Throws unless the action is allowed.
 *
 * The refusal is normally "no such artifact", never "you are not allowed to see
 * this one". Saying an artifact exists but is not yours confirms it exists,
 * which is exactly what a private artifact must not do. Anybody holding an id
 * they were never given gets the same answer as if they had invented it.
 *
 * An expired link is the one exception, and a deliberate one. The person is
 * holding a link somebody gave them; "no such artifact" would read as a bug in
 * the product rather than as an answer, and would send them to the owner over
 * some other channel to ask what broke. They are told it expired, and offered a
 * way to ask for it back. Nobody reaches this without having had access
 * already, because accessReason resolves them to 'no-access' otherwise.
 */
export function requireAccess(
  principal: Principal,
  artifact: ArtifactAccessFacts,
  action: ArtifactAction,
): void {
  if (canAccess(principal, artifact, action)) return;

  if (accessReason(principal, artifact) === 'expired') throw linkExpired(artifact.expiresAt);

  throw notFound();
}
