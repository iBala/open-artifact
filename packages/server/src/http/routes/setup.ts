/**
 * Serving the two public discovery documents: /setup.md and /llms.txt.
 *
 * Both are public and unauthenticated on purpose. /setup.md is the first thing
 * an assistant fetches when it is being set up, before it has a session.
 * /llms.txt is the llmstxt.org overview a model reads to understand what this is.
 * Served as plain text so whatever reads them — a terminal `curl`, a web
 * assistant's fetch tool — gets the text, not a download.
 */

import type { Context, Hono } from 'hono';
import type { AppContext, AppEnv } from '../app.js';
import { setupDoc } from '../../setup/setup-doc.js';
import { llmsTxt } from '../../setup/llms-txt.js';

function textResponder(contentType: string, body: string) {
  return (c: Context<AppEnv>) => {
    c.header('Content-Type', contentType);
    c.header('Cache-Control', 'public, max-age=300');
    c.header('X-Content-Type-Options', 'nosniff');
    return c.body(body);
  };
}

export function registerSetupRoutes(app: Hono<AppEnv>, context: AppContext): void {
  const setup = textResponder('text/markdown; charset=utf-8', setupDoc(context.config.baseUrl));
  const llms = textResponder('text/plain; charset=utf-8', llmsTxt(context.config.baseUrl));

  // /setup.md is what the install sentence points at; /setup is a friendly alias.
  app.get('/setup.md', setup);
  app.get('/setup', setup);

  // /llms.txt is the llmstxt.org convention; /llm.txt covers the common typo.
  app.get('/llms.txt', llms);
  app.get('/llm.txt', llms);
}
