/**
 * The six digits somebody types to sign in.
 *
 * Why a code and not a link: a link in an email is opened by the mail client's
 * own browser, which has none of the person's tabs and none of their session.
 * They sign in somewhere they did not choose to be, and whatever they were doing
 * in the tab they started in is stranded. A code keeps them where they are.
 *
 * What a code costs us, and what pays for it: six digits is a million
 * combinations, where the link token it replaces was 256 bits. A million is
 * nothing to a machine, so the code alone cannot be the whole defence. Three
 * things carry it instead, and all three are load-bearing:
 *
 * 1. A code is tied to one email address. Guessing means guessing an address's
 *    code, not stumbling onto any live code anywhere.
 * 2. A code dies after five guesses (see MAX_ATTEMPTS in auth/service.ts). Nobody
 *    gets a million tries; they get five.
 * 3. A code lives ten minutes, and asking for a new one kills the old one, so
 *    there is never more than one live code per address to aim at.
 *
 * Remove any one of those and six digits becomes guessable.
 */

import { randomInt, timingSafeEqual, createHmac } from 'node:crypto';

export const CODE_LENGTH = 6;

/**
 * A fresh code.
 *
 * crypto.randomInt, never Math.random: Math.random is seeded predictably enough
 * that watching a few codes would let somebody work out the next one, which turns
 * a million combinations into one.
 *
 * Leading zeros are kept. Throwing away codes that start with 0 would shrink the
 * space by a tenth for no reason, and "042 719" reads back perfectly well.
 */
export function generateSignInCode(): string {
  return randomInt(0, 10 ** CODE_LENGTH)
    .toString()
    .padStart(CODE_LENGTH, '0');
}

/**
 * What gets stored.
 *
 * An HMAC keyed with the instance secret, not a plain hash, and this is the one
 * place in the codebase where that distinction matters.
 *
 * Everywhere else a secret is 256 random bits, so a plain SHA-256 of it cannot be
 * reversed: there is nothing to try. A sign-in code is six digits. Somebody
 * holding a copy of the database could hash all one million and read off every
 * live code in a few milliseconds, which would turn a database backup into a way
 * to sign in as anybody with a code in flight.
 *
 * Keying it with SESSION_SECRET closes that. The million guesses are still cheap,
 * but they are useless without the key, which lives in the environment rather
 * than in the database. A stolen database on its own is worth nothing again.
 *
 * The address is mixed in too, so the same six digits sent to two people store
 * differently and one person's row says nothing about anybody else's.
 */
export function hashSignInCode(secret: string, email: string, code: string): string {
  return createHmac('sha256', secret).update(`${email}:${code}`).digest('hex');
}

/**
 * Accepts what a person actually typed or pasted: spaces, dashes, or the grouped
 * form the email shows. Anything that is not six digits after that comes back as
 * null, and the caller treats it as a wrong code.
 */
export function normaliseSignInCode(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const digits = input.replace(/\D/g, '');
  return digits.length === CODE_LENGTH ? digits : null;
}

/** "428913" as "428 913", which is how it is shown and read back. */
export function formatSignInCode(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

/**
 * Compares two stored hashes without leaking, through how long it takes, how much
 * of the guess was right. Both are hex strings of the same length, so a plain
 * timing-safe compare is enough.
 */
export function hashesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
