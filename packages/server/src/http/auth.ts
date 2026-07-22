/**
 * Temporary write authorisation for Sprint 1.
 *
 * A single shared token from the environment stands in for real accounts. It is
 * replaced by per-user sessions and API tokens in Sprint 2 (ticket 2.9), and this
 * file goes away with it.
 *
 * It fails closed: an instance with no token set refuses every write rather than
 * accepting anonymous ones.
 */

import type { MiddlewareHandler } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import type { Config } from '../config.js';
import { ApiError } from '../errors.js';
import type { AppEnv } from './app.js';

export function requireWriteToken(config: Config): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (config.devApiToken === null) {
      throw new ApiError(
        'unauthenticated',
        'This server has no DEV_API_TOKEN set, so it accepts no writes. Set one and restart.',
      );
    }

    const header = c.req.header('authorization') ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';

    if (!constantTimeEquals(presented, config.devApiToken)) {
      throw new ApiError(
        'unauthenticated',
        'Missing or invalid token. Send it as: Authorization: Bearer <token>',
      );
    }

    await next();
  };
}

/** Compares without leaking how much of the token matched through response timing. */
function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
