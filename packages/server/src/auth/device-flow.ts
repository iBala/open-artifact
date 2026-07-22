/**
 * Signing in from the command line.
 *
 * A terminal cannot receive a redirect, so this works the way signing into a TV
 * app does. The CLI asks for a code, prints a short one and a URL, and starts
 * polling. The person opens the URL in a browser they are already signed into,
 * checks that the code matches what their terminal is showing, and approves. The
 * CLI's next poll comes back with a token.
 *
 * Two separate secrets, on purpose:
 *
 * - The device code is long, random, held only by the CLI, and never displayed.
 *   It is what the token is actually handed out for.
 * - The user code is short enough to read across a desk. On its own it is worth
 *   nothing: approving one gives an attacker nothing unless they also hold the
 *   device code, which they cannot see.
 *
 * The person is asked to confirm the code matches. That is what stops somebody
 * ringing up and reading out their own code for a victim to approve.
 */

import { eq, and, isNull } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { deviceCodes, type DeviceCodeRow } from '../db/schema.js';
import { newId } from '../ids.js';
import { nowIso } from '../time.js';
import { ApiError } from '../errors.js';
import { generateToken, hashToken, generateUserCode, normaliseUserCode } from './tokens.js';
import type { AuthService, IssuedApiToken } from './service.js';

/** How long the person has to approve before the code goes stale. */
export const DEVICE_CODE_MINUTES = 10;

/** How often the CLI should poll, in seconds. */
export const DEVICE_POLL_INTERVAL_SECONDS = 2;

export interface StartedDeviceLogin {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresInSeconds: number;
  intervalSeconds: number;
}

/** What a poll found. The CLI reacts to `state`. */
export type DevicePollResult =
  | { state: 'pending' }
  | { state: 'denied' }
  | { state: 'expired' }
  | { state: 'approved'; token: IssuedApiToken };

export class DeviceFlowService {
  private readonly db: Db;
  private readonly auth: AuthService;
  private readonly baseUrl: string;

  constructor(options: { db: Db; auth: AuthService; baseUrl: string }) {
    this.db = options.db;
    this.auth = options.auth;
    this.baseUrl = options.baseUrl;
  }

  start(label?: string | null): StartedDeviceLogin {
    const deviceCode = generateToken();
    const userCode = this.uniqueUserCode();

    this.db
      .insert(deviceCodes)
      .values({
        id: newId('dev'),
        deviceCodeHash: hashToken(deviceCode),
        userCode,
        label: label ?? null,
        createdAt: nowIso(),
        expiresAt: new Date(Date.now() + DEVICE_CODE_MINUTES * 60 * 1000).toISOString(),
      })
      .run();

    return {
      deviceCode,
      userCode,
      // The code is in the URL so the person does not have to type it, but the
      // approval screen still shows it and asks them to check it matches.
      verificationUrl: `${this.baseUrl}/auth/device?code=${encodeURIComponent(userCode)}`,
      expiresInSeconds: DEVICE_CODE_MINUTES * 60,
      intervalSeconds: DEVICE_POLL_INTERVAL_SECONDS,
    };
  }

  /** What the CLI calls, repeatedly, while it waits. */
  poll(deviceCode: string): DevicePollResult {
    const record = this.db
      .select()
      .from(deviceCodes)
      .where(eq(deviceCodes.deviceCodeHash, hashToken(deviceCode)))
      .get();

    if (!record) {
      throw new ApiError(
        'unauthenticated',
        'This sign-in is not one this server knows about. Run `open-artifact login` again.',
      );
    }

    if (record.deniedAt !== null) return { state: 'denied' };
    if (record.claimedAt !== null) {
      // A token is handed out once. A second poll for the same code means
      // something has gone wrong, or someone is replaying it.
      throw new ApiError(
        'unauthenticated',
        'This sign-in has already been completed. Run `open-artifact login` again.',
      );
    }
    if (record.expiresAt <= nowIso()) return { state: 'expired' };
    if (record.approvedAt === null || record.approvedByUserId === null) return { state: 'pending' };

    // Claim it, and only if it is still unclaimed. Two polls arriving together
    // means exactly one of them changes a row and gets the token.
    const claimed = this.db
      .update(deviceCodes)
      .set({ claimedAt: nowIso() })
      .where(and(eq(deviceCodes.id, record.id), isNull(deviceCodes.claimedAt)))
      .run();
    if (claimed.changes === 0) return { state: 'pending' };

    const token = this.auth.createApiToken(record.approvedByUserId, record.label);
    return { state: 'approved', token };
  }

  /** Looks up a pending request by the short code, for the approval screen. */
  findByUserCode(userCode: string): DeviceCodeRow | undefined {
    return this.db
      .select()
      .from(deviceCodes)
      .where(eq(deviceCodes.userCode, normaliseUserCode(userCode)))
      .get();
  }

  approve(userCode: string, userId: string): void {
    const record = this.requirePending(userCode);
    this.db
      .update(deviceCodes)
      .set({ approvedAt: nowIso(), approvedByUserId: userId })
      .where(eq(deviceCodes.id, record.id))
      .run();
  }

  deny(userCode: string): void {
    const record = this.requirePending(userCode);
    this.db
      .update(deviceCodes)
      .set({ deniedAt: nowIso() })
      .where(eq(deviceCodes.id, record.id))
      .run();
  }

  private requirePending(userCode: string): DeviceCodeRow {
    const record = this.findByUserCode(userCode);
    if (!record) {
      throw new ApiError(
        'not_found',
        'That code does not match anything. Check the code your terminal is showing.',
      );
    }
    if (record.expiresAt <= nowIso()) {
      throw new ApiError(
        'validation_failed',
        'That code has expired. Run `open-artifact login` again to get a new one.',
      );
    }
    if (record.approvedAt !== null || record.deniedAt !== null) {
      throw new ApiError('validation_failed', 'That code has already been answered.');
    }
    return record;
  }

  private uniqueUserCode(): string {
    // Codes are short, so a collision is unlikely but not impossible. Retry a
    // few times rather than handing two terminals the same code.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = generateUserCode();
      if (!this.findByUserCode(candidate)) return candidate;
    }
    throw new ApiError('internal_error', 'Could not allocate a sign-in code. Try again.');
  }
}
