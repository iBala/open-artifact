/**
 * The artifact API. This is the product's contract: the CLI, the skill, the web
 * app and any third-party client all go through these endpoints.
 *
 * Every route that names an artifact loads it and then asks artifacts/access.ts
 * whether this caller may do this thing. No handler decides that for itself.
 */

import type { Hono } from 'hono';
import type { AppContext, AppEnv } from '../app.js';
import { ApiError } from '../../errors.js';
import { requireUser, currentUser } from '../session.js';

import { requireAccess, canAccess } from '../../artifacts/access.js';
import type { ArtifactDetail, ArtifactSummary } from '../../artifacts/service.js';

export function registerArtifactRoutes(app: Hono<AppEnv>, context: AppContext): void {
  const { artifacts, sharing, config , rateLimiter } = context;

  // The commonest failure this product will ever see is an agent retrying a
  // failing publish in a loop. Counted per person, per hour.
  const publishLimit = rateLimiter.middleware({
    by: 'user',
    bucket: 'publish',
    limit: config.limits.publishesPerHour,
    windowSeconds: 3600,
  });

  /** Publish a new artifact. It belongs to whoever published it. */
  app.post('/api/artifacts', requireUser, publishLimit, async (c) => {
    const body = await readJsonBody(c.req.raw);
    const created = artifacts.create({
      ownerId: currentUser(c).id,
      type: requireString(body, 'type'),
      content: requireString(body, 'content'),
      title: optionalString(body, 'title'),
    });
    return c.json(withUrl(created, config.baseUrl), 201);
  });

  /**
   * Read one artifact by the slug in its URL.
   *
   * The viewer has a slug, not an id, and needs to know who published it to say
   * so in the title bar. Registered before /api/artifacts/:id so "by-slug" is
   * never mistaken for an artifact id.
   */
  app.get('/api/artifacts/by-slug/:slug', (c) => {
    const artifact = artifacts.getBySlug(c.req.param('slug'));
    requireAccess(c.get('user') ?? null, sharing.accessFactsFor(artifact), 'view');

    const owner = context.auth.findUserById(artifact.ownerId);
    const facts = sharing.accessFactsFor(artifact);
    const principal = c.get('user') ?? null;

    return c.json({
      ...withUrl(artifact, config.baseUrl),
      ownerName: owner?.displayName ?? null,
      ownerEmail: owner?.email ?? null,
      // What this reader may do, answered here rather than left for the client
      // to work out. It cannot work it out: seeing who an artifact is shared
      // with is itself something only the owner may do.
      youMay: {
        comment: canAccess(principal, facts, 'comment'),
        manage: canAccess(principal, facts, 'manage'),
      },
    });
  });

  /** Read one artifact, including its content. */
  app.get('/api/artifacts/:id', (c) => {
    const artifact = artifacts.get(c.req.param('id'));
    requireAccess(c.get('user') ?? null, sharing.accessFactsFor(artifact), 'view');
    return c.json(withUrl(artifact, config.baseUrl));
  });

  /** Everything I published, newest change first. */
  app.get('/api/artifacts', requireUser, (c) => {
    return c.json({
      artifacts: artifacts
        .listOwnedBy(currentUser(c).id)
        .map((artifact) => withUrl(artifact, config.baseUrl)),
    });
  });

  /** Replace an artifact's content. The URL stays the same. */
  app.put('/api/artifacts/:id', requireUser, publishLimit, async (c) => {
    const artifact = artifacts.get(c.req.param('id'));
    requireAccess(currentUser(c), sharing.accessFactsFor(artifact), 'manage');

    const body = await readJsonBody(c.req.raw);
    const updated = artifacts.update(artifact.id, {
      content: requireString(body, 'content'),
      type: optionalString(body, 'type'),
      title: optionalString(body, 'title'),
      baseVersion: requireInteger(body, 'baseVersion'),
    });

    // Every anchored comment is re-checked against the new content. Ones whose
    // passage survived keep their place; ones whose passage is gone become
    // document-level and are marked, rather than being moved to whatever text
    // now sits where they used to point.
    const lost = context.comments.relocateAll(updated.id, updated.content, updated.type);
    if (lost > 0) {
      c.get('logger')?.info('comment anchors lost their place', { artifactId: updated.id, lost });
    }

    return c.json(withUrl(updated, config.baseUrl));
  });

  /**
   * Delete an artifact and everything attached to it. Requires an explicit
   * confirm flag: an agent should never delete someone's work by getting a URL
   * slightly wrong.
   */
  app.delete('/api/artifacts/:id', requireUser, (c) => {
    const artifact = artifacts.get(c.req.param('id'));
    requireAccess(currentUser(c), sharing.accessFactsFor(artifact), 'manage');

    if (c.req.query('confirm') !== 'true') {
      throw new ApiError(
        'validation_failed',
        'Deleting is permanent. Repeat the request with ?confirm=true to go ahead.',
      );
    }
    artifacts.delete(artifact.id);
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
