/**
 * Identifier generation.
 *
 * Two kinds, deliberately different lengths:
 * - Record ids are internal handles. Random so they leak nothing about volume.
 * - Slugs sit in artifact URLs. A private artifact's URL is not a secret on its
 *   own (access is always checked server-side), but it should still be
 *   impossible to find one by guessing, so slugs get far more entropy.
 */

import { customAlphabet } from 'nanoid';

// No look-alike characters. A slug gets read aloud and typed by hand sometimes.
const ALPHABET = '0123456789abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';

const generateId = customAlphabet(ALPHABET, 16);
const generateSlug = customAlphabet(ALPHABET, 24);

/** An internal record id, prefixed so a stray id in a log says what it belongs to. */
export function newId(prefix: string): string {
  return `${prefix}_${generateId()}`;
}

/** The unguessable part of an artifact URL. 24 characters of this alphabet is ~140 bits. */
export function newSlug(): string {
  return generateSlug();
}
