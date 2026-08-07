import { describe, it, expect } from 'vitest';
import {
  parseExpiry,
  expiryDeadline,
  isExpired,
  describeRemaining,
  DEFAULT_EXPIRY,
  PUBLIC_EXPIRY,
  EXPIRY_PRESETS,
} from '../src/expiry.js';

/**
 * How long a link lasts.
 *
 * The parser is shared by the CLI, the web app and the server, so what "7d"
 * means has to be one answer. The interesting cases are the refusals: a
 * duration this misreads sets somebody's link to die at the wrong time, and
 * they find out when a colleague tells them the link is broken.
 */

describe('reading a duration', () => {
  it('takes hours and days, however they are spelled', () => {
    expect(parseExpiry('1h')).toEqual({ token: '1h', hours: 1 });
    expect(parseExpiry('24h')).toEqual({ token: '24h', hours: 24 });
    expect(parseExpiry('36 hours')).toEqual({ token: '36h', hours: 36 });
    expect(parseExpiry('7d')).toEqual({ token: '7d', hours: 168 });
    expect(parseExpiry('30 DAYS')).toEqual({ token: '30d', hours: 720 });
    expect(parseExpiry('  90d  ')).toEqual({ token: '90d', hours: 2160 });
  });

  it('takes the several ways people write forever', () => {
    for (const word of ['forever', 'never', 'none', 'Forever']) {
      expect(parseExpiry(word), word).toEqual({ token: 'forever', hours: null });
    }
  });

  /**
   * The one that matters. "7" could mean either, and guessing wrong by a factor
   * of 24 in the wrong direction kills a link six days early.
   */
  it('refuses a bare number rather than guessing the unit', () => {
    expect(parseExpiry('7')).toBeNull();
    expect(parseExpiry('90')).toBeNull();
  });

  it('refuses nonsense, zero, and negatives', () => {
    for (const bad of ['', 'soon', '0d', '0h', '-3d', '3w', '3 months', '1.5d', 'd7']) {
      expect(parseExpiry(bad), bad).toBeNull();
    }
  });

  it('refuses a duration so long it is really a typo for forever', () => {
    expect(parseExpiry('99999d')).toBeNull();
    // Ten years is still fine.
    expect(parseExpiry('3650d')).not.toBeNull();
  });

  it('reads back every preset the picker offers', () => {
    for (const preset of EXPIRY_PRESETS) {
      expect(parseExpiry(preset.token), preset.token).not.toBeNull();
    }
    expect(parseExpiry(DEFAULT_EXPIRY)).toEqual({ token: '90d', hours: 2160 });
    expect(parseExpiry(PUBLIC_EXPIRY)).toEqual({ token: '7d', hours: 168 });
  });
});

describe('turning a duration into a deadline', () => {
  const noon = '2026-08-07T12:00:00.000Z';

  it('counts forward from the moment it is given', () => {
    expect(expiryDeadline({ token: '24h', hours: 24 }, noon)).toBe('2026-08-08T12:00:00.000Z');
    expect(expiryDeadline({ token: '7d', hours: 168 }, noon)).toBe('2026-08-14T12:00:00.000Z');
  });

  it('gives forever no deadline at all', () => {
    expect(expiryDeadline({ token: 'forever', hours: null }, noon)).toBeNull();
  });
});

describe('whether a deadline has passed', () => {
  const now = '2026-08-07T12:00:00.000Z';

  it('treats no deadline as forever, not as already gone', () => {
    expect(isExpired(null, now)).toBe(false);
  });

  it('is past at the deadline itself, not a moment after', () => {
    expect(isExpired('2026-08-07T12:00:00.000Z', now)).toBe(true);
    expect(isExpired('2026-08-07T11:59:59.999Z', now)).toBe(true);
    expect(isExpired('2026-08-07T12:00:00.001Z', now)).toBe(false);
  });

  /**
   * Both sides are fixed-width UTC ISO-8601, which is why comparing them as
   * text is the same answer as comparing them as dates. If either side ever
   * stops being that format this silently starts lying, so it is worth pinning.
   */
  it('orders correctly across a year, a month and a day boundary', () => {
    expect(isExpired('2025-12-31T23:59:59.999Z', now)).toBe(true);
    expect(isExpired('2026-07-31T23:59:59.999Z', now)).toBe(true);
    expect(isExpired('2026-08-06T23:59:59.999Z', now)).toBe(true);
    expect(isExpired('2026-09-01T00:00:00.000Z', now)).toBe(false);
    expect(isExpired('2027-01-01T00:00:00.000Z', now)).toBe(false);
  });
});

describe('saying how long is left', () => {
  const now = '2026-08-07T12:00:00.000Z';

  it('counts in hours up to two days and in days beyond', () => {
    expect(describeRemaining('2026-08-07T12:30:00.000Z', now)).toBe('in under an hour');
    expect(describeRemaining('2026-08-07T13:00:00.000Z', now)).toBe('in 1 hour');
    expect(describeRemaining('2026-08-08T12:00:00.000Z', now)).toBe('in 24 hours');
    expect(describeRemaining('2026-08-14T12:00:00.000Z', now)).toBe('in 7 days');
    expect(describeRemaining('2026-11-05T12:00:00.000Z', now)).toBe('in 90 days');
  });

  it('has a word for forever and one for gone', () => {
    expect(describeRemaining(null, now)).toBe('never');
    expect(describeRemaining('2020-01-01T00:00:00.000Z', now)).toBe('expired');
  });
});
