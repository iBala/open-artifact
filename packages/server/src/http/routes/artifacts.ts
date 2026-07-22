/**
 * The artifact API. This is the product's contract: the CLI, the skill, the web
 * app and any third-party client all go through these endpoints.
 */

import type { Hono } from 'hono';
import type { AppContext, AppEnv } from '../app.js';
import { ApiError } from '../../errors.js';
import { requireWriteToken } from '../auth.js';
import type { ArtifactDetail, ArtifactSummary } from '../../artifacts/service.js';

export function registerArtifactRoutes(app: Hono<AppEnv>, context: AppContext): void {
  const { artifacts, config } = context;
  const requireToken = requireWriteToken(config);

  /** Publish a new artifact. */
  app.post('/api/artifacts', requireToken, async (c) => {
    const body = await readJsonBody(c.req.raw);
    const created = artifacts.create({
      type: requireString(body, 'type'),
      content: requireString(body, 'content'),
      title: optionalString(body, 'title'),
    });
    return c.json(withUrl(created, config.baseUrl), 201);
  });

  /** Read one artifact, including its content. */
  app.get('/api/artifacts/:id', requireToken, (c) => {
    return c.json(withUrl(artifacts.get(c.req.param('id')), config.baseUrl));
  });

  /** List artifacts. Scoped to the signed-in user once accounts exist (Sprint 2). */
  app.get('/api/artifacts', requireToken, (c) => {
    return c.json({
      artifacts: artifacts.list().map((artifact) => withUrl(artifact, config.baseUrl)),
    });
  });

  /** Replace an artifact's content. The URL stays the same. */
  app.put('/api/artifacts/:id', requireToken, async (c) => {
    const body = await readJsonBody(c.req.raw);
    const updated = artifacts.update(c.req.param('id'), {
      content: requireString(body, 'content'),
      type: optionalString(body, 'type'),
      title: optionalString(body, 'title'),
      baseVersion: requireInteger(body, 'baseVersion'),
    });
    return c.json(withUrl(updated, config.baseUrl));
  });

  /**
   * Delete an artifact and everything attached to it. Requires an explicit
   * confirm flag: an agent should never delete someone's work by getting a URL
   * slightly wrong.
   */
  app.delete('/api/artifacts/:id', requireToken, (c) => {
    if (c.req.query('confirm') !== 'true') {
      throw new ApiError(
        'validation_failed',
        'Deleting is permanent. Repeat the request with ?confirm=true to go ahead.',
      );
    }
    artifacts.delete(c.req.param('id'));
    return c.body(null, 204);
  });
}

/** Adds the viewing URL, so no client has to know how to build one. */
function withUrl<T extends ArtifactSummary | ArtifactDetail>(
  artifact: T,
  baseUrl: string,
): T & { url: string } {
  return { ...artifact, url: `${baseUrl}/a/${artifact.slug}` };
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw new ApiError('validation_failed', 'The request body must be JSON.');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ApiError('validation_failed', 'The request body must be a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string') {
    throw new ApiError('validation_failed', `${field} is required and must be text.`);
  }
  return value;
}

function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new ApiError('validation_failed', `${field} must be text.`);
  }
  return value;
}

function requireInteger(body: Record<string, unknown>, field: string): number {
  const value = body[field];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ApiError('validation_failed', `${field} is required and must be a whole number.`);
  }
  return value;
}
