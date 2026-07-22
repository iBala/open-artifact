/**
 * Health endpoint. Used by the compose healthcheck and by uptime monitoring.
 *
 * "Healthy" means the database answers and migrations are applied. A server that
 * can accept TCP connections but cannot read its own database is not healthy, and
 * a restart loop is better than silently serving errors.
 */

import type { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import type { AppContext, AppEnv } from '../app.js';

export function registerHealthRoutes(app: Hono<AppEnv>, context: AppContext): void {
  app.get('/healthz', (c) => {
    try {
      context.database.db.get<{ count: number }>(
        sql`select count(*) as count from sqlite_master where type = 'table' and name = 'artifacts'`,
      );
      return c.json({ status: 'ok' });
    } catch (error) {
      c.get('logger')?.error('health check failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json(
        { status: 'error', message: 'The database is not reachable.' },
        503,
      );
    }
  });
}
