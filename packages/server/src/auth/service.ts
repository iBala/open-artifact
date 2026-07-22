/**
 * Accounts and sign-in.
 *
 * There are no passwords in this product. Proving you can read email at an
 * address is the whole of authentication, whether that proof comes from following
 * a link we sent or from Google saying it verified the same address. Both paths
 * land on one account row, because the email address is the identity.
 *
 * Everything a person holds (sign-in link, session cookie, CLI token) is a random
 * secret we hand out once and store only as a hash. See auth/tokens.ts.
 */

import { eq, and, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import {
  users,
  authSessions,
  apiTokens,
  magicLinks,
  type UserRow,
  type ApiTokenRow,
} from '../db/schema.js';
import { newId } from '../ids.js';
import { nowIso } from '../time.js';
import { ApiError } from '../errors.js';
import { generateToken, hashToken } from './tokens.js';
import { normaliseEmail, domainOf } from './email-address.js';
import type { SignupMode } from '../config.js';

/** How long a sign-in link works. Long enough to switch apps, short enough to matter. */
export const MAGIC_LINK_MINUTES = 15;

/** How long a browser stays signed in without being used. */
export const SESSION_DAYS = 30;

/**
 * How long a CLI token lasts, sliding forward every time it is used. An agent that
 * publishes weekly never gets logged out; one that goes quiet for a quarter does.
 */
export const API_TOKEN_DAYS = 90;

export interface IssuedSession {
  token: string;
  expiresAt: string;
}

export interface IssuedApiToken {
  token: string;
  tokenId: string;
  expiresAt: string;
}

export interface SignInResult {
  user: UserRow;
  session: IssuedSession;
  /** True when this sign-in created the account. */
  isNewAccount: boolean;
  /** Where the person asked to end up, if they followed a link into a shared artifact. */
  redirectTo: string | null;
}

export interface AuthServiceOptions {
  db: Db;
  signupMode: SignupMode;
  signupAllowedDomains: string[];
  /**
   * Whether this address has been invited by being shared something. Sharing does
   * not exist until Sprint 4, so it defaults to "no". Wiring it up is what makes
   * invite-only mode mean anything.
   */
  hasPendingInvite?: (email: string) => boolean;
  /**
   * Called the moment somebody proves they own an address, so anything already
   * shared with it becomes theirs. Only ever called with a verified address:
   * attaching on an unverified one would let anybody claim somebody else's
   * invitations.
   */
  onEmailVerified?: (userId: string, email: string) => void;
}

export class AuthService {
  private readonly db: Db;
  private readonly signupMode: SignupMode;
  private readonly signupAllowedDomains: string[];
  private readonly hasPendingInvite: (email: string) => boolean;
  private readonly onEmailVerified: (userId: string, email: string) => void;

  constructor({
    db,
    signupMode,
    signupAllowedDomains,
    hasPendingInvite = () => false,
    onEmailVerified = () => {},
  }: AuthServiceOptions) {
    this.db = db;
    this.signupMode = signupMode;
    this.signupAllowedDomains = signupAllowedDomains;
    this.hasPendingInvite = hasPendingInvite;
    this.onEmailVerified = onEmailVerified;
  }

  // ---------------------------------------------------------------------------
  // Signing in by email link
  // ---------------------------------------------------------------------------

  /**
   * Creates a sign-in link for an address. Returns the token to put in the link.
   *
   * This deliberately does not tell the caller whether the address has an account,
   * and it creates a link even for an address that is not allowed to sign up. The
   * refusal happens when the link is followed, so that asking for a link is never
   * a way to find out who has an account here.
   */
  requestMagicLink(email: string, redirectTo?: string | null): { token: string; expiresAt: string } {
    const address = normaliseEmail(email);
    const token = generateToken();
    const expiresAt = minutesFromNow(MAGIC_LINK_MINUTES);

    this.db
      .insert(magicLinks)
      .values({
        id: newId('mlk'),
        email: address,
        tokenHash: hashToken(token),
        redirectTo: redirectTo ?? null,
        createdAt: nowIso(),
        expiresAt,
      })
      .run();

    return { token, expiresAt };
  }

  /** Follows a sign-in link: verifies it, signs the person in, and burns the link. */
  verifyMagicLink(token: string, sessionLabel?: string): SignInResult {
    const link = this.db
      .select()
      .from(magicLinks)
      .where(eq(magicLinks.tokenHash, hashToken(token)))
      .get();

    // One message for every failure: an expired link and a link that never existed
    // should be indistinguishable from outside.
    const invalid = () =>
      new ApiError(
        'unauthenticated',
        'This sign-in link is no longer valid. Links work once and expire after 15 minutes. Ask for a new one.',
      );

    if (!link) throw invalid();
    if (link.usedAt !== null) throw invalid();
    if (link.expiresAt <= nowIso()) throw invalid();

    // Burn it before doing anything else, and only if it is still unused. If two
    // requests arrive together, exactly one of them changes a row.
    const burn = this.db
      .update(magicLinks)
      .set({ usedAt: nowIso() })
      .where(and(eq(magicLinks.id, link.id), isNull(magicLinks.usedAt)))
      .run();
    if (burn.changes === 0) throw invalid();

    const { user, isNewAccount } = this.findOrCreateUser(link.email, { verified: true });
    const session = this.createSession(user.id, sessionLabel);

    return { user, session, isNewAccount, redirectTo: link.redirectTo };
  }

  // ---------------------------------------------------------------------------
  // Accounts
  // ---------------------------------------------------------------------------

  /**
   * Finds the account for a verified address, creating it if the instance's signup
   * rules allow. Both sign-in methods come through here, which is what makes them
   * two doors into one account.
   */
  findOrCreateUser(
    email: string,
    options: { verified: boolean; displayName?: string | null },
  ): { user: UserRow; isNewAccount: boolean } {
    const address = normaliseEmail(email);
    const existing = this.db.select().from(users).where(eq(users.email, address)).get();

    if (existing) {
      const updates: Partial<UserRow> = {};
      if (options.verified && existing.emailVerified === 0) updates.emailVerified = 1;
      // Google gives us a name; an email link does not. Fill it in when we learn it,
      // but never overwrite one already there.
      if (options.displayName && !existing.displayName) updates.displayName = options.displayName;

      if (Object.keys(updates).length > 0) {
        const updated = { ...existing, ...updates, updatedAt: nowIso() };
        this.db
          .update(users)
          .set({ ...updates, updatedAt: updated.updatedAt })
          .where(eq(users.id, existing.id))
          .run();
        if (updates.emailVerified === 1) this.onEmailVerified(existing.id, existing.email);
        return { user: updated, isNewAccount: false };
      }

      // Already verified: anything shared since their last sign-in attaches now.
      if (options.verified && existing.emailVerified === 1) {
        this.onEmailVerified(existing.id, existing.email);
      }
      return { user: existing, isNewAccount: false };
    }

    this.requireSignupAllowed(address);

    const timestamp = nowIso();
    const user: UserRow = {
      id: newId('usr'),
      email: address,
      displayName: options.displayName ?? null,
      emailVerified: options.verified ? 1 : 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      deletedAt: null,
    };
    this.db.insert(users).values(user).run();
    if (options.verified) this.onEmailVerified(user.id, user.email);
    return { user, isNewAccount: true };
  }

  /**
   * Whether this address may create an account here.
   *
   * The first account is always allowed, whatever the mode. Without that, a fresh
   * install on the default invite-only setting could never be used by anybody:
   * there is nobody to send the first invitation.
   */
  canSignUp(email: string): boolean {
    if (this.countUsers() === 0) return true;

    switch (this.signupMode) {
      case 'open':
        return true;
      case 'domain-allowlist':
        return this.signupAllowedDomains.includes(domainOf(email));
      case 'invite-only':
        return this.hasPendingInvite(normaliseEmail(email));
    }
  }

  private requireSignupAllowed(email: string): void {
    if (this.canSignUp(email)) return;
    throw new ApiError(
      'forbidden',
      this.signupMode === 'domain-allowlist'
        ? 'This instance only accepts accounts from certain email domains. Ask whoever runs it to add yours.'
        : 'This instance is invite only. Ask someone here to share an artifact with you, and signing in will then work.',
    );
  }

  countUsers(): number {
    const row = this.db.get<{ count: number }>(sql`select count(*) as count from users`);
    return row?.count ?? 0;
  }

  findUserByEmail(email: string): UserRow | undefined {
    return this.db.select().from(users).where(eq(users.email, normaliseEmail(email))).get();
  }

  findUserById(id: string): UserRow | undefined {
    return this.db.select().from(users).where(eq(users.id, id)).get();
  }

  // ---------------------------------------------------------------------------
  // Browser sessions
  // ---------------------------------------------------------------------------

  createSession(userId: string, label?: string): IssuedSession {
    const token = generateToken();
    const timestamp = nowIso();
    const expiresAt = daysFromNow(SESSION_DAYS);

    this.db
      .insert(authSessions)
      .values({
        id: newId('ses'),
        userId,
        tokenHash: hashToken(token),
        label: label ?? null,
        createdAt: timestamp,
        lastSeenAt: timestamp,
        expiresAt,
      })
      .run();

    return { token, expiresAt };
  }

  /** Returns the signed-in person for a session cookie, or null. */
  authenticateSession(token: string): UserRow | null {
    const session = this.db
      .select()
      .from(authSessions)
      .where(eq(authSessions.tokenHash, hashToken(token)))
      .get();

    if (!session) return null;
    if (session.revokedAt !== null) return null;
    if (session.expiresAt <= nowIso()) return null;

    const user = this.findUserById(session.userId);
    if (!user || user.deletedAt !== null) return null;

    this.db
      .update(authSessions)
      .set({ lastSeenAt: nowIso() })
      .where(eq(authSessions.id, session.id))
      .run();

    return user;
  }

  revokeSession(token: string): void {
    this.db
      .update(authSessions)
      .set({ revokedAt: nowIso() })
      .where(eq(authSessions.tokenHash, hashToken(token)))
      .run();
  }

  /** Which session a cookie belongs to, so the UI can mark "this browser". */
  sessionIdForToken(token: string): string | null {
    const session = this.db
      .select()
      .from(authSessions)
      .where(eq(authSessions.tokenHash, hashToken(token)))
      .get();
    return session?.id ?? null;
  }

  revokeSessionById(userId: string, sessionId: string): boolean {
    const result = this.db
      .update(authSessions)
      .set({ revokedAt: nowIso() })
      .where(and(eq(authSessions.id, sessionId), eq(authSessions.userId, userId)))
      .run();
    return result.changes > 0;
  }

  listSessions(userId: string) {
    return this.db
      .select()
      .from(authSessions)
      .where(and(eq(authSessions.userId, userId), isNull(authSessions.revokedAt)))
      .all()
      .filter((session) => session.expiresAt > nowIso());
  }

  // ---------------------------------------------------------------------------
  // CLI tokens
  // ---------------------------------------------------------------------------

  createApiToken(userId: string, label?: string | null): IssuedApiToken {
    const token = generateToken();
    const id = newId('tok');
    const expiresAt = daysFromNow(API_TOKEN_DAYS);

    this.db
      .insert(apiTokens)
      .values({
        id,
        userId,
        tokenHash: hashToken(token),
        label: label ?? null,
        createdAt: nowIso(),
        expiresAt,
      })
      .run();

    return { token, tokenId: id, expiresAt };
  }

  /**
   * Returns the person behind a CLI token, and slides its expiry forward. A token
   * in daily use never expires; one abandoned for 90 days does.
   */
  authenticateApiToken(token: string): UserRow | null {
    const record = this.db
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.tokenHash, hashToken(token)))
      .get();

    if (!record) return null;
    if (record.revokedAt !== null) return null;
    if (record.expiresAt <= nowIso()) return null;

    const user = this.findUserById(record.userId);
    if (!user || user.deletedAt !== null) return null;

    this.db
      .update(apiTokens)
      .set({ lastUsedAt: nowIso(), expiresAt: daysFromNow(API_TOKEN_DAYS) })
      .where(eq(apiTokens.id, record.id))
      .run();

    return user;
  }

  revokeApiToken(token: string): void {
    this.db
      .update(apiTokens)
      .set({ revokedAt: nowIso() })
      .where(eq(apiTokens.tokenHash, hashToken(token)))
      .run();
  }

  revokeApiTokenById(userId: string, tokenId: string): boolean {
    const result = this.db
      .update(apiTokens)
      .set({ revokedAt: nowIso() })
      .where(and(eq(apiTokens.id, tokenId), eq(apiTokens.userId, userId)))
      .run();
    return result.changes > 0;
  }

  listApiTokens(userId: string): ApiTokenRow[] {
    return this.db
      .select()
      .from(apiTokens)
      .where(and(eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)))
      .all()
      .filter((token) => token.expiresAt > nowIso());
  }
}

function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function minutesFromNow(minutes: number): string {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}
