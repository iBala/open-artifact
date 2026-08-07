/**
 * Who an artifact is shared with.
 *
 * Sharing is by email address rather than by account, because the common case is
 * sharing with somebody who has never used this instance. The invitation waits
 * for them; when they first sign in with that verified address it attaches to
 * their account, and they find the artifact already there.
 */

import { eq, and, isNull, inArray } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import {
  artifacts,
  artifactShares,
  artifactDomainShares,
  users,
  type ArtifactShareRow,
} from '../db/schema.js';
import { newId } from '../ids.js';
import { nowIso } from '../time.js';
import { ApiError } from '../errors.js';
import { normaliseEmail, isValidEmail, domainOf } from '../auth/email-address.js';
import { isPublicEmailProvider } from './public-domains.js';
import type { ArtifactAccessFacts } from './access.js';
import {
  parseExpiry,
  expiryDeadline,
  DEFAULT_EXPIRY,
  PUBLIC_EXPIRY,
  type ExpirySpec,
} from '@open-artifact/shared';

export interface PersonShare {
  id: string;
  email: string;
  /** True until they have signed in with this address. */
  pending: boolean;
  createdAt: string;
}

export interface SharingState {
  artifactId: string;
  isPublic: boolean;
  people: PersonShare[];
  domains: { id: string; domain: string; createdAt: string }[];
  /** When everybody but the owner loses access. Null means never. */
  expiresAt: string | null;
}

export class SharingService {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /** Everything the access decision needs, in one read. */
  accessFactsFor(artifact: {
    id: string;
    ownerId: string;
    isPublic: number;
    expiresAt: string | null;
  }): ArtifactAccessFacts {
    return {
      ownerId: artifact.ownerId,
      isPublic: artifact.isPublic === 1,
      expiresAt: artifact.expiresAt,
      sharedEmails: this.db
        .select()
        .from(artifactShares)
        .where(eq(artifactShares.artifactId, artifact.id))
        .all()
        .map((share) => share.email),
      sharedDomains: this.db
        .select()
        .from(artifactDomainShares)
        .where(eq(artifactDomainShares.artifactId, artifact.id))
        .all()
        .map((share) => share.domain),
    };
  }

  state(artifactId: string): SharingState {
    const artifact = this.db.select().from(artifacts).where(eq(artifacts.id, artifactId)).get();
    if (!artifact) throw new ApiError('not_found', 'No such artifact.');

    return {
      artifactId,
      isPublic: artifact.isPublic === 1,
      expiresAt: artifact.expiresAt,
      people: this.db
        .select()
        .from(artifactShares)
        .where(eq(artifactShares.artifactId, artifactId))
        .all()
        .map((share) => ({
          id: share.id,
          email: share.email,
          pending: share.userId === null,
          createdAt: share.createdAt,
        })),
      domains: this.db
        .select()
        .from(artifactDomainShares)
        .where(eq(artifactDomainShares.artifactId, artifactId))
        .all()
        .map((share) => ({
          id: share.id,
          domain: share.domain,
          createdAt: share.createdAt,
        })),
    };
  }

  /**
   * Shares with an address. Returns the share, and whether it is new: sharing
   * the same artifact with the same person twice must not send a second email.
   */
  shareWithEmail(
    artifactId: string,
    email: string,
    sharedByUserId: string,
  ): { share: ArtifactShareRow; isNew: boolean } {
    if (!isValidEmail(email)) {
      throw new ApiError('validation_failed', `"${email}" is not a valid email address.`);
    }
    const address = normaliseEmail(email);

    const artifact = this.db.select().from(artifacts).where(eq(artifacts.id, artifactId)).get();
    if (!artifact) throw new ApiError('not_found', 'No such artifact.');

    if (this.db.select().from(users).where(eq(users.id, artifact.ownerId)).get()?.email === address) {
      throw new ApiError(
        'validation_failed',
        'That is your own address. You already have access to your own artifacts.',
      );
    }

    const existing = this.db
      .select()
      .from(artifactShares)
      .where(and(eq(artifactShares.artifactId, artifactId), eq(artifactShares.email, address)))
      .get();
    if (existing) return { share: existing, isNew: false };

    // If they already have an account, attach it now rather than waiting.
    const account = this.db.select().from(users).where(eq(users.email, address)).get();

    const share: ArtifactShareRow = {
      id: newId('shr'),
      artifactId,
      email: address,
      userId: account && account.emailVerified === 1 ? account.id : null,
      createdAt: nowIso(),
      createdByUserId: sharedByUserId,
      notifiedAt: null,
    };
    // Before the insert, while this artifact still has no grants on it.
    this.stampDefaultExpiryIfFirstGrant(artifactId);
    this.db.insert(artifactShares).values(share).run();

    return { share, isNew: true };
  }

  markNotified(shareId: string): void {
    this.db
      .update(artifactShares)
      .set({ notifiedAt: nowIso() })
      .where(eq(artifactShares.id, shareId))
      .run();
  }

  /** Removing access takes effect immediately: the row is gone, so the check fails. */
  unshareEmail(artifactId: string, email: string): boolean {
    const result = this.db
      .delete(artifactShares)
      .where(
        and(
          eq(artifactShares.artifactId, artifactId),
          eq(artifactShares.email, normaliseEmail(email)),
        ),
      )
      .run();
    return result.changes > 0;
  }

  shareWithDomain(artifactId: string, domain: string, sharedByUserId: string): { isNew: boolean } {
    const normalised = normaliseDomain(domain);

    if (isPublicEmailProvider(normalised)) {
      throw new ApiError(
        'validation_failed',
        `Sharing with everybody at ${normalised} would share with anybody who has an email address there, which is most of the internet. Share with the individual addresses instead, or make the artifact public.`,
      );
    }

    const existing = this.db
      .select()
      .from(artifactDomainShares)
      .where(
        and(
          eq(artifactDomainShares.artifactId, artifactId),
          eq(artifactDomainShares.domain, normalised),
        ),
      )
      .get();
    if (existing) return { isNew: false };

    // Before the insert, while this artifact still has no grants on it.
    this.stampDefaultExpiryIfFirstGrant(artifactId);
    this.db
      .insert(artifactDomainShares)
      .values({
        id: newId('dsh'),
        artifactId,
        domain: normalised,
        createdAt: nowIso(),
        createdByUserId: sharedByUserId,
      })
      .run();

    return { isNew: true };
  }

  unshareDomain(artifactId: string, domain: string): boolean {
    const result = this.db
      .delete(artifactDomainShares)
      .where(
        and(
          eq(artifactDomainShares.artifactId, artifactId),
          eq(artifactDomainShares.domain, normaliseDomain(domain)),
        ),
      )
      .run();
    return result.changes > 0;
  }

  setPublic(artifactId: string, isPublic: boolean): void {
    // Going public shortens the clock, before the flag is set, so that the
    // first-grant stamp does not also fire and set the private default.
    const shorter = parseExpiry(PUBLIC_EXPIRY);
    if (isPublic && shorter) this.shortenTo(artifactId, shorter);

    this.db
      .update(artifacts)
      .set({ isPublic: isPublic ? 1 : 0 })
      .where(eq(artifacts.id, artifactId))
      .run();

    // Turning it off again deliberately leaves the deadline alone. Restoring
    // whatever it was before would mean remembering a value the owner cannot
    // see, and quietly extending access is the wrong way to be wrong.
  }

  // ---------------------------------------------------------------------------
  // When the link stops working
  // ---------------------------------------------------------------------------

  /**
   * Sets the deadline outright. Null spec means forever.
   *
   * The owner is the only one who can reach this, so it is allowed to extend as
   * well as shorten, including back to forever on a public artifact. The short
   * public default exists to catch the person who forgot, not to overrule the
   * person who meant it.
   */
  setExpiry(artifactId: string, spec: ExpirySpec): string | null {
    const expiresAt = expiryDeadline(spec, nowIso());
    this.db.update(artifacts).set({ expiresAt }).where(eq(artifacts.id, artifactId)).run();
    return expiresAt;
  }

  /**
   * Pushes an already-expired deadline back out to the default.
   *
   * Granting somebody access to an artifact whose link has expired would
   * otherwise do nothing at all: they get a share row, and still land on "this
   * link has expired", because the deadline is on the artifact and applies to
   * everybody. Saying yes has to mean the link works again.
   *
   * A deadline still in the future is left alone — the owner set that on
   * purpose, and letting one more person in is not a reason to move it.
   */
  reviveIfExpired(artifactId: string): boolean {
    const artifact = this.db.select().from(artifacts).where(eq(artifacts.id, artifactId)).get();
    if (!artifact) return false;
    if (artifact.expiresAt === null || artifact.expiresAt > nowIso()) return false;

    const spec = parseExpiry(DEFAULT_EXPIRY);
    if (!spec) return false;

    this.db
      .update(artifacts)
      .set({ expiresAt: expiryDeadline(spec, nowIso()) })
      .where(eq(artifacts.id, artifactId))
      .run();
    return true;
  }

  /**
   * Stamps the default deadline the first time an artifact is shared with
   * anybody at all.
   *
   * Not at creation: an artifact only the owner can reach has nothing to
   * expire, and a clock started at creation would already have run down by the
   * time somebody shared it three months later. Doing it here is also what
   * keeps null unambiguous — on an artifact that already has a grant, null can
   * only be a deliberate "forever".
   *
   * A deadline that is already set is left alone even with no grants on it,
   * because somebody setting one before sharing has said what they want and
   * the default would overwrite it. The gap this leaves is small and falls the
   * safe way: setting "forever" on an artifact nobody can see yet is stored as
   * null and is indistinguishable from never having chosen, so the first share
   * still stamps 90 days. Ending up with a deadline somebody meant to remove is
   * a visible surprise in the share panel; ending up with none when they
   * expected the default would not be.
   */
  private stampDefaultExpiryIfFirstGrant(artifactId: string): void {
    const existing = this.db.select().from(artifacts).where(eq(artifacts.id, artifactId)).get();

    // Sharing with somebody whose link is already dead has to bring it back.
    // Without this the new person is emailed a link that has never worked for
    // them, which is the worst version of this feature going wrong: it looks
    // like the share failed, and the owner has no reason to suspect the clock.
    if (existing?.expiresAt && this.reviveIfExpired(artifactId)) return;

    if (existing?.expiresAt) return;
    if (this.hasAnyGrant(artifactId)) return;

    const spec = parseExpiry(DEFAULT_EXPIRY);
    if (!spec) return;
    this.db
      .update(artifacts)
      .set({ expiresAt: expiryDeadline(spec, nowIso()) })
      .where(eq(artifacts.id, artifactId))
      .run();
  }

  /**
   * Brings the deadline in to a duration, and never pushes it out.
   *
   * The rule behind making something public, and behind what an agent is
   * allowed to do over MCP: taking access away early is always safe, giving
   * more of it is the thing that needs a person. Somebody who set an hour and
   * then made the artifact public meant the hour.
   *
   * A deadline that has already passed is not "already shorter" — it is a
   * closed door. Every caller here is in the middle of granting access, so an
   * expired deadline is treated as no constraint and gets replaced. Otherwise
   * making an expired artifact public would appear to work and change nothing.
   */
  shortenTo(artifactId: string, spec: ExpirySpec): string | null {
    const artifact = this.db.select().from(artifacts).where(eq(artifacts.id, artifactId)).get();
    if (!artifact) return null;

    const deadline = expiryDeadline(spec, nowIso());
    if (deadline === null) return artifact.expiresAt;

    const live = artifact.expiresAt !== null && artifact.expiresAt > nowIso() ? artifact.expiresAt : null;
    if (live !== null && live <= deadline) return live;

    this.db
      .update(artifacts)
      .set({ expiresAt: deadline })
      .where(eq(artifacts.id, artifactId))
      .run();
    return deadline;
  }

  /** Whether anybody but the owner can currently reach this artifact. */
  private hasAnyGrant(artifactId: string): boolean {
    const artifact = this.db.select().from(artifacts).where(eq(artifacts.id, artifactId)).get();
    if (artifact?.isPublic === 1) return true;

    const person = this.db
      .select()
      .from(artifactShares)
      .where(eq(artifactShares.artifactId, artifactId))
      .get();
    if (person) return true;

    return (
      this.db
        .select()
        .from(artifactDomainShares)
        .where(eq(artifactDomainShares.artifactId, artifactId))
        .get() !== undefined
    );
  }

  // ---------------------------------------------------------------------------
  // Invitations waiting for somebody who has not signed in yet
  // ---------------------------------------------------------------------------

  /** Whether anything is waiting for this address. Invite-only signup asks this. */
  hasPendingInvite(email: string): boolean {
    return (
      this.db
        .select()
        .from(artifactShares)
        .where(eq(artifactShares.email, normaliseEmail(email)))
        .get() !== undefined
    );
  }

  /**
   * Attaches every invitation waiting for this address to their account.
   *
   * Called the moment somebody proves they own an address. Only ever called with
   * a verified one: attaching on an unverified address would let anybody claim
   * whatever had been shared with it.
   */
  attachPendingInvites(userId: string, email: string): number {
    const address = normaliseEmail(email);

    const waiting = this.db
      .select()
      .from(artifactShares)
      .where(and(eq(artifactShares.email, address), isNull(artifactShares.userId)))
      .all();

    if (waiting.length === 0) return 0;

    this.db
      .update(artifactShares)
      .set({ userId })
      .where(
        inArray(
          artifactShares.id,
          waiting.map((share) => share.id),
        ),
      )
      .run();

    return waiting.length;
  }

  /** Artifacts somebody else shared with this person, newest change first. */
  sharedWith(user: { id: string; email: string; emailVerified: number }) {
    if (user.emailVerified !== 1) return [];

    const byEmail = this.db
      .select()
      .from(artifactShares)
      .where(eq(artifactShares.email, normaliseEmail(user.email)))
      .all()
      .map((share) => share.artifactId);

    const byDomain = this.db
      .select()
      .from(artifactDomainShares)
      .where(eq(artifactDomainShares.domain, domainOf(user.email)))
      .all()
      .map((share) => share.artifactId);

    const ids = [...new Set([...byEmail, ...byDomain])];
    if (ids.length === 0) return [];

    return this.db
      .select()
      .from(artifacts)
      .where(inArray(artifacts.id, ids))
      .all()
      // Not artifacts they own: those are in the other list on the dashboard.
      .filter((artifact) => artifact.ownerId !== user.id)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}

/** Accepts "@example.com", "Example.com" and "https://example.com". */
function normaliseDomain(domain: string): string {
  const cleaned = domain
    .trim()
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');

  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(cleaned)) {
    throw new ApiError(
      'validation_failed',
      `"${domain}" is not a domain. Give one like example.com.`,
    );
  }
  return cleaned;
}
