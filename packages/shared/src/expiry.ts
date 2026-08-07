/**
 * How long a link lasts.
 *
 * An artifact has one deadline, held on the artifact itself, and it applies to
 * everybody except the owner. One clock rather than one per share: two people
 * looking at the same link and disagreeing about whether it still works is a
 * support ticket, and "when does this link die" should have one answer.
 *
 * Null means forever. There is no separate "unset" state — an artifact nobody
 * can reach has nothing to expire, so the deadline is only ever stamped at the
 * moment access is first granted. After that, null is a deliberate choice.
 *
 * The durations live here, in the shared package, because the picker in the web
 * app, the CLI flag and the server all have to agree on what "7d" means. They
 * are spelled the way people say them: hours or days.
 */

/** What the picker offers. Anything parseable is still accepted from the CLI. */
export const EXPIRY_PRESETS = [
  { token: '1h', label: '1 hour' },
  { token: '24h', label: '24 hours' },
  { token: '7d', label: '7 days' },
  { token: '30d', label: '30 days' },
  { token: '90d', label: '90 days' },
  { token: 'forever', label: 'Forever' },
] as const;

/** The deadline for a newly shared artifact. */
export const DEFAULT_EXPIRY = '90d';

/**
 * The deadline applied when an artifact is made public.
 *
 * Shorter than the private default on purpose. "Anybody with the link" is the
 * setting people turn on to show somebody something once and then forget about,
 * and the cost of forgetting is a document readable by the world for as long as
 * the instance runs.
 */
export const PUBLIC_EXPIRY = '7d';

/** A parsed duration. Null hours means forever. */
export interface ExpirySpec {
  /** The text it came from, normalised: '12h', '3d', 'forever'. */
  token: string;
  /** Hours from now, or null for forever. */
  hours: number | null;
}

const MAX_HOURS = 24 * 365 * 10;

/**
 * Reads "12h", "3 days", "forever". Returns null if it is not a duration.
 *
 * Deliberately generous about spelling, because this is typed by hand into a
 * terminal and by agents into a tool call. It is strict about the unit: an
 * unqualified number could mean anything, and guessing wrong sets a link to
 * die in 7 hours when somebody meant 7 days.
 */
export function parseExpiry(value: string): ExpirySpec | null {
  const cleaned = value.trim().toLowerCase().replace(/\s+/g, '');

  if (cleaned === 'forever' || cleaned === 'never' || cleaned === 'none') {
    return { token: 'forever', hours: null };
  }

  const match = /^(\d+)(h|hr|hrs|hour|hours|d|day|days)$/.exec(cleaned);
  const digits = match?.[1];
  const unit = match?.[2];
  if (digits === undefined || unit === undefined) return null;

  const amount = Number(digits);
  if (!Number.isInteger(amount) || amount < 1) return null;

  const isDays = unit.startsWith('d');
  const hours = isDays ? amount * 24 : amount;
  if (hours > MAX_HOURS) return null;

  return { token: `${amount}${isDays ? 'd' : 'h'}`, hours };
}

/** The deadline a duration produces, as UTC ISO-8601. Null for forever. */
export function expiryDeadline(spec: ExpirySpec, fromIso: string): string | null {
  if (spec.hours === null) return null;
  return new Date(new Date(fromIso).getTime() + spec.hours * 3_600_000).toISOString();
}

/**
 * Whether a deadline has passed.
 *
 * Both sides are UTC ISO-8601 with milliseconds, which is fixed-width, so
 * comparing them as strings is the same answer as comparing them as dates and
 * costs no parsing. The rest of this codebase expires credentials the same way.
 */
export function isExpired(expiresAt: string | null, nowIso: string): boolean {
  return expiresAt !== null && expiresAt <= nowIso;
}

/** "in 3 days", "in 5 hours", "in a few minutes". For telling somebody what they just set. */
export function describeRemaining(expiresAt: string | null, nowIso: string): string {
  if (expiresAt === null) return 'never';
  if (isExpired(expiresAt, nowIso)) return 'expired';

  const hours = (new Date(expiresAt).getTime() - new Date(nowIso).getTime()) / 3_600_000;
  if (hours < 1) return 'in under an hour';
  if (hours < 48) {
    const whole = Math.round(hours);
    return `in ${whole} ${whole === 1 ? 'hour' : 'hours'}`;
  }
  const days = Math.round(hours / 24);
  return `in ${days} days`;
}
