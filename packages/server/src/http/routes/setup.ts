/**
 * Serving the setup instructions at /setup.md.
 *
 * Public and unauthenticated on purpose: an assistant being set up has no
 * session yet, and this is the first thing it fetches. Plain Markdown so
 * whatever reads it — a terminal `curl`, a web assistant's fetch tool — gets the
 * text, not a download.
 */

import type { Context, Hono } from 'hono';
import type { AppContext, AppEnv } from '../app.js';
import { setupDoc } from '../../setup/setup-doc.js';

export function registerSetupRoutes(app: Hono<AppEnv>, context: AppContext): void {
  const body = setupDoc(context.config.baseUrl);

  const serve = (c: Context<AppEnv>) => {
    c.header('Content-Type', 'text/markdown; charset=utf-8');
    c.header('Cache-Control', 'public, max-age=300');
    c.header('X-Content-Type-Options', 'nosniff');
    return c.body(body);
  };

  // /setup.md is what the install sentence points at; /setup is a friendly alias.
  app.get('/setup.md', serve);
  app.get('/setup', serve);
}
