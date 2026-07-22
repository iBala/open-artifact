/**
 * Closing your account.
 *
 * One endpoint, and the only one in the product that removes a person. What it
 * actually does is in auth/account-deletion.ts; this is the door.
 */

import type { Hono } from 'hono';
import type { AppContext, AppEnv } from '../app.js';
import { ApiError } from '../../errors.js';
import { requireUser, currentUser } from '../session.js';
import { clearSessionCookie } from '../cookies.js';
import { deleteAccount } from '../../auth/account-deletion.js';

export function registerAccountRoutes(app: Hono<AppEnv>, context: AppContext): void {
  const { config, database } = context;

  /**
   * Delete your account and everything you published.
   *
   * Requires an explicit confirm flag, the same as deleting an artifact does.
   * This is the most permanent thing the API can do, and an agent should never
   * reach it by getting a URL slightly wrong.
   */
  app.delete('/api/auth/account', requireUser, (c) => {
    if (c.req.query('confirm') !== 'true') {
      throw new ApiError(
        'validation_failed',
        'Closing your account is permanent. Repeat the request with ?confirm=true to go ahead.',
      );
    }

    const user = currentUser(c);
    const summary = deleteAccount(database.db, user.id);

    // Every session went with the account, so the cookie the browser is holding
    // no longer works. Clearing it means the browser stops sending a dead one.
    clearSessionCookie(c, config);

    c.get('logger')?.info('account closed', {
      userId: user.id,
      artifactsDeleted: summary.artifactsDeleted,
      commentsAnonymised: summary.commentsAnonymised,
    });

    return c.body(null, 204);
  });
}
