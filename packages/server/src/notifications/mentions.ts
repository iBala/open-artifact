/**
 * Naming somebody in a comment.
 *
 * A mention in the text is `@` followed by an email address, because that is the
 * one thing that cannot be ambiguous. Display names collide, local parts collide
 * across domains, and a mention that resolves to the wrong person is worse than
 * one that does not resolve at all. The composer inserts the address; the reader
 * sees it rendered as a name.
 *
 * Mentions are resolved when the comment is written, against the people who
 * could actually be named at that moment, and stored as rows. Searching the text
 * later would mean an address that becomes a user next week silently turns into
 * a mention in something written today.
 */

import { normaliseEmail } from '../auth/email-address.js';

/**
 * Every address named in a body.
 *
 * Deliberately strict about what ends a mention. An address is allowed the
 * characters addresses are allowed, and stops at whitespace or the punctuation
 * that ordinarily follows a name in a sentence, so "ask @sam@example.com, then"
 * names sam rather than "sam@example.com,".
 */
export function mentionedAddresses(body: string): string[] {
  const found = new Set<string>();

  for (const match of body.matchAll(/@([^\s@]+@[^\s@]+\.[^\s@]+?)(?=[\s.,;:!?)\]]|$)/g)) {
    const address = match[1];
    if (address) found.add(normaliseEmail(address));
  }

  return [...found];
}

/**
 * Who may be named on an artifact.
 *
 * The people it is explicitly shared with, plus anybody who has already
 * commented. Never every account on the instance: on a public artifact that
 * would turn the mention box into a directory of everybody who has ever signed
 * in, which is not something a reader should be handed.
 *
 * The same list is used for the suggestions the composer offers and for
 * resolving what was actually typed, so the two can never disagree.
 */
export interface MentionCandidate {
  email: string;
  displayName: string | null;
  userId: string | null;
  /** False when they cannot currently see the artifact. */
  hasAccess: boolean;
}
