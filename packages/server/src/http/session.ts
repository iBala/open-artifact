/**
 * Works out who is making a request, if anyone.
 *
 * Two kinds of credential, one result. A browser sends a session cookie; the CLI
 * sends `Authorization: Bearer <token>`. Both end up as the same thing: a user on
 * the request, or nobody.
 *
 * This never rejects. Plenty of routes are readable by anyone (a public artifact,
 * the login page), so deciding what an anonymous request may do belongs to the
 * route, not here.
 */

import type { MiddlewareHandler } from 'hono';
import type { AuthService } from '../auth/service.js';
import { ApiError } from '../errors.js';
import { readSessionCookie } from './cookies.js';
import type { AppEnv } from './app.js';
import type { UserRow } from '../db/schema.js';

export function attachUser(auth: AuthService): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const header = c.req.header('authorization');
    if (header?.startsWith('Bearer ')) {
      const user = auth.authenticateApiToken(header.slice('Bearer '.length).trim());
      if (user) c.set('user', user);
    } else {
      const cookie = readSessionCookie(c);
      if (cookie) {
        const user = auth.authenticateSession(cookie);
        if (user) c.set('user', user);
      }
    }
    await next();
  };
}

/** For routes that require someone signed in. */
export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get('user')) {
    throw new ApiError(
      'unauthenticated',
      'You need to be signed in to do this. Run `open-artifact login`, or sign in in your browser.',
    );
  }
  await next();
};

/** Reads the signed-in person off a request that has already been through requireUser. */
export function currentUser(c: { get: (key: 'user') => UserRow | undefined }): UserRow {
  const user = c.get('user');
  if (!user) throw new ApiError('unauthenticated', 'You are not signed in.');
  return user;
}
