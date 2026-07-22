/**
 * Secrets that stand in for a person: session cookies, CLI tokens, sign-in links.
 *
 * Two rules hold everywhere in this file's callers:
 *
 * 1. The secret is generated once, handed to the person, and never stored. Only
 *    its SHA-256 hash goes in the database. Someone who walks off with a copy of
 *    the database walks off with hashes, not working logins.
 *
 * 2. Lookups are by hash, so they are exact-match index lookups rather than
 *    comparisons in application code. There is no timing signal to measure.
 *
 * SHA-256 without a work factor is right here, unlike for passwords: these are
 * 256-bit random values, so there is no dictionary to try.
 */

import { randomBytes, createHash } from 'node:crypto';

/** A fresh secret, URL-safe so it can sit in a link or a header untouched. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/** What actually gets stored. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * The short code a person reads off one screen and types into another, during CLI
 * sign-in. Deliberately short and deliberately not the real secret: it only
 * identifies a pending request that the CLI is already holding a long secret for.
 *
 * The alphabet leaves out characters that get confused when read aloud or typed:
 * no 0/O, no 1/I/L, no U (which is heard as "you").
 */
const USER_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

export function generateUserCode(): string {
  const characters = Array.from(randomBytes(8)).map(
    (byte) => USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length] ?? 'X',
  );
  // Grouped as XXXX-XXXX, which is easier to read back than eight run together.
  return `${characters.slice(0, 4).join('')}-${characters.slice(4).join('')}`;
}

/** Accepts what a person typed: any case, with or without the dash. */
export function normaliseUserCode(input: string): string {
  const stripped = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (stripped.length !== 8) return stripped;
  return `${stripped.slice(0, 4)}-${stripped.slice(4)}`;
}
