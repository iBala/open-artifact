/**
 * Rate limits.
 *
 * What these are actually for, in order of how likely each is:
 *
 * 1. An agent in a loop. Far and away the most common: something retries a
 *    failing publish a thousand times and fills a disk. The publish limit is
 *    sized to be invisible to anybody working normally and immediate for a loop.
 *
 * 2. Guessing sign-in codes from many addresses. A single code already dies
 *    after five wrong guesses, but nothing stopped somebody working through a
 *    list of addresses. The auth limit is per IP for exactly that.
 *
 * 3. Using somebody else's instance as a mail relay. Asking for a sign-in code
 *    sends an email to an address the requester chose, so it is limited harder
 *    than anything else here.
 *
 * Counted in memory, not in the database. A limit that survives a restart is not
 * worth a write on every request, and this product is one process. A self-hoster
 * who puts two behind a load balancer gets twice the limit, which is a fine
 * trade for never touching the disk on a hot path.
 */

import type { MiddlewareHandler } from 'hono';
import { ApiError } from '../errors.js';
import type { AppEnv } from './app.js';

export interface RateLimit {
  /** How many are allowed in the window. */
  limit: number;
  /** How long the window is, in seconds. */
  windowSeconds: number;
}

/**
 * A fixed window per key.
 *
 * Deliberately not a sliding window or a token bucket. A fixed window lets
 * somebody burst at a boundary, which for these limits means an agent gets
 * twice its allowance once in a while. That is not a problem worth the extra
 * moving parts, and the limits below are set with it in mind.
 */
class Windows {
  private readonly counts = new Map<string, { count: number; resetsAt: number }>();
  private lastSweep = 0;

  /** Returns null when allowed, or how many seconds until it would be. */
  check(key: string, limit: RateLimit, now: number): number | null {
    this.sweep(now);

    const existing = this.counts.get(key);
    if (!existing || existing.resetsAt <= now) {
      this.counts.set(key, { count: 1, resetsAt: now + limit.windowSeconds * 1000 });
      return null;
    }

    if (existing.count < limit.limit) {
      existing.count += 1;
      return null;
    }

    return Math.max(1, Math.ceil((existing.resetsAt - now) / 1000));
  }

  /**
   * Drops expired entries now and then.
   *
   * Without this the map is a slow memory leak keyed by every address anybody
   * ever tried. Sweeping on a timer would keep the process awake; sweeping on
   * use costs nothing when nothing is happening.
   */
  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;

    for (const [key, entry] of this.counts) {
      if (entry.resetsAt <= now) this.counts.delete(key);
    }
  }

  /** Tests only. */
  clear(): void {
    this.counts.clear();
    this.lastSweep = 0;
  }
}

/**
 * The limiter for one server.
 *
 * Deliberately not a module-level singleton. Two servers in one process, which
 * is exactly what the test suite is, would otherwise share one set of counters
 * and limit each other. Anything that behaves differently depending on what else
 * has run is worth avoiding even when the production case only ever has one.
 */
export interface RateLimiter {
  middleware: (options: RateLimitOptions) => MiddlewareHandler<AppEnv>;
  /**
   * The same budget, asked directly rather than as middleware. Draws on the
   * same counters: a share spent here is a share the sharing endpoint no
   * longer has. For code that consumes a limited action mid-request — a
   * mention that shares, an MCP tool call — where there is no route boundary
   * to hang the middleware on. Returns null when allowed, or seconds to wait.
   */
  check: (bucket: string, who: string, limit: RateLimit) => number | null;
}

export function createRateLimiter(now: () => number = () => Date.now()): RateLimiter {
  const windows = new Windows();

  return {
    check: (bucket, who, limit) => windows.check(`${bucket}:${who}`, limit, now()),
    middleware: (options) => async (c, next) => {
      const who = options.by === 'user' ? (c.get('user')?.id ?? addressOf(c)) : addressOf(c);
      const retryAfter = windows.check(`${options.bucket}:${who}`, options, now());

      if (retryAfter !== null) {
        c.header('Retry-After', String(retryAfter));
        throw new ApiError(
          'rate_limited',
          `That is more than this instance allows. Try again in ${describe(retryAfter)}.`,
          { retryAfterSeconds: retryAfter },
        );
      }

      await next();
    },
  };
}

export interface RateLimitOptions extends RateLimit {
  /**
   * What to count by. 'user' falls back to the address when nobody is signed in,
   * because an unauthenticated endpoint has no user to count against.
   */
  by: 'user' | 'ip';
  /** Distinguishes one limit from another for the same caller. */
  bucket: string;
}

/**
 * Who a request came from.
 *
 * Behind a reverse proxy the socket address is always the proxy, so the
 * forwarded header is what identifies the caller. That header is trivially
 * forged by anybody talking to this server directly, which is why it is only
 * ever used for rate limiting and never for anything that grants access.
 */
function addressOf(c: { req: { header: (name: string) => string | undefined } }): string {
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]?.trim() ?? 'unknown';
  return c.req.header('x-real-ip') ?? 'unknown';
}

function describe(seconds: number): string {
  if (seconds < 60) return `${seconds} seconds`;
  const minutes = Math.ceil(seconds / 60);
  return minutes === 1 ? 'a minute' : `${minutes} minutes`;
}
