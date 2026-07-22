/**
 * The bell, and the access requests behind it.
 */

import type { Hono } from 'hono';
import type { AppContext, AppEnv } from '../app.js';
import { ApiError } from '../../errors.js';
import { requireUser, currentUser } from '../session.js';
import { requireAccess } from '../../artifacts/access.js';

export function registerNotificationRoutes(app: Hono<AppEnv>, context: AppContext): void {
  const { notifications, artifacts, sharing, comments, config, mailer } = context;

  /** Everything waiting for me, newest first. */
  app.get('/api/notifications', requireUser, (c) => {
    const user = currentUser(c);
    return c.json({
      notifications: notifications.list(user.id),
      unread: notifications.unreadCount(user.id),
    });
  });

  app.post('/api/notifications/:id/read', requireUser, (c) => {
    if (!notifications.markRead(currentUser(c).id, c.req.param('id'))) {
      // Already read, or not theirs. Neither is worth an error page.
      return c.body(null, 204);
    }
    return c.body(null, 204);
  });

  app.post('/api/notifications/read-all', requireUser, (c) => {
    return c.json({ marked: notifications.markAllRead(currentUser(c).id) });
  });

  /**
   * Who may be named in a comment here.
   *
   * The people it is shared with plus anybody who has already commented, never
   * every account on the instance. On a public artifact that would turn the
   * mention box into a directory of everybody who has ever signed in.
   */
  app.get('/api/artifacts/:id/mention-candidates', requireUser, (c) => {
    const artifact = artifacts.get(c.req.param('id'));
    const facts = sharing.accessFactsFor(artifact);
    requireAccess(currentUser(c), facts, 'comment');

    return c.json({
      candidates: notifications.mentionCandidates(artifact.id, facts.sharedEmails),
    });
  });

  /** Requests waiting on me, as somebody who owns artifacts. */
  app.get('/api/access-requests', requireUser, (c) => {
    // The title comes back with it, so the panel can say what is being asked
    // about without a second request per row.
    return c.json({
      requests: notifications.pendingRequestsFor(currentUser(c).id).map((request) => ({
        id: request.id,
        artifactId: request.artifactId,
        artifactTitle: artifacts.get(request.artifactId).title,
        email: request.email,
        createdAt: request.createdAt,
      })),
    });
  });

  /**
   * Answering one. Granting shares the artifact and releases whatever mention
   * was waiting on it.
   */
  app.post('/api/access-requests/:id/decide', requireUser, async (c) => {
    const user = currentUser(c);
    const body = await readJson(c.req.raw);

    if (typeof body.grant !== 'boolean') {
      throw new ApiError('validation_failed', 'grant is required and must be true or false.');
    }

    const pending = notifications
      .pendingRequestsFor(user.id)
      .find((request) => request.id === c.req.param('id'));
    if (!pending) throw new ApiError('not_found', 'No such request waiting on you.');

    const decided = notifications.decideRequest(pending.id, body.grant);
    if (!decided) throw new ApiError('not_found', 'That request has already been answered.');

    if (body.grant) {
      const artifact = artifacts.get(decided.artifactId);
      const { share, isNew } = sharing.shareWithEmail(artifact.id, decided.email, user.id);

      if (isNew && share.notifiedAt === null) {
        const { sharedArtifactEmail } = await import('../../mail/templates.js');
        const { instanceNameFrom } = await import('./auth.js');
        const content = sharedArtifactEmail({
          sharedBy: user.displayName ?? user.email,
          artifactTitle: artifact.title,
          url: `${config.baseUrl}/a/${artifact.slug}`,
          instanceName: instanceNameFrom(config.baseUrl),
          recipientHasAccount: share.userId !== null,
        });
        await mailer.send({
          to: share.email,
          subject: content.subject,
          text: content.text,
          html: content.html,
        });
        sharing.markNotified(share.id);
      }
    }

    void comments;
    return c.json({ granted: body.grant });
  });
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await request.json();
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new ApiError('validation_failed', 'The request body must be a JSON object.');
  }
}
