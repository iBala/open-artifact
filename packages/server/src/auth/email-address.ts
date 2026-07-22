/**
 * Email addresses are this product's identity key: signing in by link and signing
 * in with Google land on the same account because they carry the same address,
 * and sharing an artifact with an address works before that person has an account.
 *
 * That only holds if every address is normalised the same way, everywhere, once.
 * Everything that touches an address goes through here.
 */

import { ApiError } from '../errors.js';

/**
 * Deliberately permissive. The real proof that an address is valid is that
 * someone received mail at it and followed the link, which is what this product
 * does anyway. Rejecting unusual-but-legal addresses would be worse than
 * accepting one that bounces.
 */
const SHAPE = /^[^\s@,;]+@[^\s@,;.]+(\.[^\s@,;.]+)+$/;

export function isValidEmail(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length <= 254 && SHAPE.test(trimmed);
}

/** Lowercased and trimmed. This is the form stored and compared everywhere. */
export function normaliseEmail(value: string): string {
  return value.trim().toLowerCase();
}

/** Normalises, or throws the error the API should return. */
export function requireEmail(value: unknown, field = 'email'): string {
  if (typeof value !== 'string' || !isValidEmail(value)) {
    throw new ApiError('validation_failed', `${field} must be a valid email address.`);
  }
  return normaliseEmail(value);
}

/** The part after the @, lowercased. Used for domain sharing and signup rules. */
export function domainOf(email: string): string {
  return normaliseEmail(email).split('@')[1] ?? '';
}
