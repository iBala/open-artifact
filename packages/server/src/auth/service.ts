/**
 * Accounts and sign-in.
 *
 * There are no passwords in this product. Proving you can read email at an
 * address is the whole of authentication, whether that proof comes from typing
 * back a code we sent there or from Google saying it verified the same address.
 * Both paths land on one account row, because the email address is the identity.
 *
 * Everything a person holds (sign-in code, session cookie, CLI token) is a random
 * secret we hand out once and store only as a hash. See auth/tokens.ts, and
 * auth/codes.ts for why a six-digit secret needs more than a hash to be safe.
 */

import { eq, and, isNull, desc, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import {
  users,
  authSessions,
  apiTokens,
  signInCodes,
  type UserRow,
  type ApiTokenRow,
} from '../db/schema.js';
import { newId } from '../ids.js';
import { nowIso } from '../time.js';
import { ApiError } from '../errors.js';
import { generateToken, hashToken } from './tokens.js';
import { generateSignInCode, hashSignInCode, hashesMatch, normaliseSignInCode } from './codes.js';
import { normaliseEmail, domainOf } from './email-address.js';
import type { SignupMode } from '../config.js';

/**
 * How long a sign-in code works. Long enough to switch to a mail app and back,
 * short enough that a code left in an inbox is not a standing invitation.
 */
export const SIGN_IN_CODE_MINUTES = 10;

/**
 * How many codes may be tried against one request before it is thrown away.
 *
 * This number is the whole reason six digits is safe. Five guesses against a
 * million combinations is a one in two hundred thousand chance, and getting
 * another five means asking for another code, which the person whose address it
 * is watches arrive in their inbox.
 */
export const MAX_SIGN_IN_CODE_ATTEMPTS = 5;

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
  /** Where the person asked to end up, if they arrived from a link to a shared artifact. */
  redirectTo: string | null;
}

/** What a command-line sign-in gets back: a token, not a session. */
export interface CliSignInResult extends IssuedApiToken {
  email: string;
  /** True when this sign-in created the account. */
  isNewAccount: boolean;
}

export interface AuthServiceOptions {
  db: Db;
  signupMode: SignupMode;
  /**
   * The instance secret, used to key the hash of sign-in codes. Six digits are
   * guessable from a stolen database unless the hash is keyed; see auth/codes.ts.
   */
  sessionSecret: string;
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
  private readonly sessionSecret: string;
  private readonly signupAllowedDomains: string[];
  private readonly hasPendingInvite: (email: string) => boolean;
  private readonly onEmailVerified: (userId: string, email: string) => void;

  constructor({
    db,
    sessionSecret,
    signupMode,
    signupAllowedDomains,
    hasPendingInvite = () => false,
    onEmailVerified = () => {},
  }: AuthServiceOptions) {
    this.db = db;
    this.sessionSecret = sessionSecret;
    this.signupMode = signupMode;
    this.signupAllowedDomains = signupAllowedDomains;
    this.hasPendingInvite = hasPendingInvite;
    this.onEmailVerified = onEmailVerified;
  }

  // ---------------------------------------------------------------------------
  // Signing in with an emailed code
  // ---------------------------------------------------------------------------

  /**
   * Creates a sign-in code for an address and returns the digits to email.
   *
   * This deliberately does not tell the caller whether the address has an account,
   * and it creates a code even for an address that is not allowed to sign up. The
   * refusal happens when the code is entered, so that asking for a code is never a
   * way to find out who has an account here.
   *
   * Asking again throws away whatever was outstanding for the address. Two live
   * codes would double what a guesser can aim at, and would leave somebody typing
   * the code from the older email and being told it is wrong.
   */
  requestSignInCode(email: string, redirectTo?: string | null): { code: string; expiresAt: string } {
    const address = normaliseEmail(email);
    const code = generateSignInCode();
    const expiresAt = minutesFromNow(SIGN_IN_CODE_MINUTES);
    const timestamp = nowIso();

    this.db
      .update(signInCodes)
      .set({ usedAt: timestamp })
      .where(and(eq(signInCodes.email, address), isNull(signInCodes.usedAt)))
      .run();

    this.db
      .insert(signInCodes)
      .values({
        id: newId('sic'),
        email: address,
        codeHash: hashSignInCode(this.sessionSecret, address, code),
        attempts: 0,
        redirectTo: redirectTo ?? null,
        createdAt: timestamp,
        expiresAt,
      })
      .run();

    return { code, expiresAt };
  }

  /**
   * Checks a code, signs the person in, and burns the code.
   *
   * Every way this can fail says the same sentence: a wrong code, an expired one,
   * one already used, one guessed at too many times, and an address that never
   * asked for anything are indistinguishable from outside. Telling them apart
   * would say whether an address is in the middle of signing in, and a "wrong
   * code" that differs from "no such code" tells a guesser they are on a live one.
   */
  verifySignInCode(email: string, code: string, sessionLabel?: string): SignInResult {
    const { user, isNewAccount, redirectTo } = this.consumeSignInCode(email, code);
    const session = this.createSession(user.id, sessionLabel);
    return { user, session, isNewAccount, redirectTo };
  }

  /**
   * The same email-and-code sign-in, but it hands back a command-line token
   * instead of a browser session. This is how `open-artifact login` works: the
   * person is emailed a code exactly as on the web, types it into their terminal,
   * and gets a token. No browser, no device to approve.
   *
   * It goes through the identical check as the web — same code, same single use,
   * same five attempts — so a terminal sign-in is neither weaker nor stronger than
   * signing in on the site.
   */
  exchangeCodeForToken(email: string, code: string, label?: string | null): CliSignInResult {
    const { user, isNewAccount } = this.consumeSignInCode(email, code);
    const token = this.createApiToken(user.id, label ?? null);
    return { email: user.email, isNewAccount, ...token };
  }

  /**
   * Checks an emailed code and returns who it signs in, or throws. Shared by the
   * web session flow and the command-line token flow so the two can never drift
   * apart on how a code is spent, counted or burned.
   */
  private consumeSignInCode(
    email: string,
    code: string,
  ): { user: UserRow; isNewAccount: boolean; redirectTo: string | null } {
    const address = normaliseEmail(email);

    // See the note above: one sentence for every failure.
    const invalid = () =>
      new ApiError(
        'unauthenticated',
        `That code is not valid. Codes work once and expire after ${SIGN_IN_CODE_MINUTES} minutes. Ask for a new one.`,
      );

    const entered = normaliseSignInCode(code);
    // Not six digits, so it cannot be anybody's code. Rejected before the lookup,
    // which means a client-side typo never spends one of the five real attempts.
    if (entered === null) throw invalid();

    const record = this.db
      .select()
      .from(signInCodes)
      .where(and(eq(signInCodes.email, address), isNull(signInCodes.usedAt)))
      .orderBy(desc(signInCodes.createdAt))
      .get();

    if (!record) throw invalid();
    if (record.expiresAt <= nowIso()) throw invalid();

    // Count the guess before checking it. Doing it the other way round would let
    // somebody who can cut the connection mid-request guess for free.
    const attempts = record.attempts + 1;
    this.db
      .update(signInCodes)
      .set({ attempts })
      .where(eq(signInCodes.id, record.id))
      .run();

    if (!hashesMatch(record.codeHash, hashSignInCode(this.sessionSecret, address, entered))) {
      // Out of attempts: the code is gone, not merely refused. Anything still
      // holding the right digits is now holding nothing.
      if (attempts >= MAX_SIGN_IN_CODE_ATTEMPTS) this.burnSignInCode(record.id);
      throw invalid();
    }

    // Right code, but the budget was already spent. Normally the wrong guess that
    // used the last attempt kills the row on its way out; this catches a row that
    // survived that (a crash between the two writes, say). Either way the sixth
    // attempt fails, whether or not the digits were right.
    if (attempts > MAX_SIGN_IN_CODE_ATTEMPTS) {
      this.burnSignInCode(record.id);
      throw invalid();
    }

    // Burn before signing in, and only if it is still unused. If two requests
    // arrive together, exactly one of them changes a row.
    if (!this.burnSignInCode(record.id)) throw invalid();

    const { user, isNewAccount } = this.findOrCreateUser(record.email, { verified: true });
    return { user, isNewAccount, redirectTo: record.redirectTo };
  }

  /** Marks a code used. False when somebody else got there first. */
  private burnSignInCode(id: string): boolean {
    const result = this.db
      .update(signInCodes)
      .set({ usedAt: nowIso() })
      .where(and(eq(signInCodes.id, id), isNull(signInCodes.usedAt)))
      .run();
    return result.changes > 0;
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

    // A closed account never signs back in. Deletion rewrites the address to one
    // that can never receive mail, so in practice nobody could get a code for it
    // anyway. This is the belt to that pair of braces: if the address ever
    // became reachable again, this is what still refuses.
    if (existing?.deletedAt) {
      throw new ApiError(
        'unauthenticated',
        'That account was closed. Sign up again with the same address if you want a new one.',
      );
    }

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
