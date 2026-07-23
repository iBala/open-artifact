/**
 * Changing who can see an artifact.
 *
 * Only the owner, always. The refusal for anybody else is "no such artifact",
 * the same as everywhere: being told an artifact exists but you cannot manage it
 * confirms it exists.
 */

import type { Hono } from 'hono';
import type { AppContext, AppEnv } from '../app.js';
import { ApiError } from '../../errors.js';
import { requireUser, currentUser } from '../session.js';
import { requireAccess } from '../../artifacts/access.js';
import { sharedArtifactEmail } from '../../mail/templates.js';
import { instanceNameFrom } from './auth.js';
import { readJsonObject, jsonBodyCap } from '../body.js';

export function registerSharingRoutes(app: Hono<AppEnv>, context: AppContext): void {
  const { artifacts, sharing, config, mailer, notifications, rateLimiter } = context;

  const bodyCap = jsonBodyCap(config.maxArtifactBytes);

  // Sharing emails an address the sharer chose, which is the same mail-relay
  // problem the sign-in limit exists for, one account further in. Anyone with an
  // account could otherwise send as many as they liked.
  const shareLimit = rateLimiter.middleware({
    by: 'user',
    bucket: 'share',
    limit: config.limits.sharesPerHour,
    windowSeconds: 3600,
  });

  /** Loads the artifact and checks the caller owns it. */
  function ownedArtifact(id: string, user: Parameters<typeof requireAccess>[0]) {
    const artifact = artifacts.get(id);
    requireAccess(user, sharing.accessFactsFor(artifact), 'manage');
    return artifact;
  }

  /** Who this artifact is shared with. */
  app.get('/api/artifacts/:id/sharing', requireUser, (c) => {
    const artifact = ownedArtifact(c.req.param('id'), currentUser(c));
    return c.json(sharing.state(artifact.id));
  });

  /** Share with a person, by address. */
  app.post('/api/artifacts/:id/sharing/people', requireUser, shareLimit, async (c) => {
    const user = currentUser(c);
    const artifact = ownedArtifact(c.req.param('id'), user);
    const body = await readJsonObject(c.req.raw, bodyCap);

    if (typeof body.email !== 'string') {
      throw new ApiError('validation_failed', 'email is required.');
    }

    const { share, isNew } = sharing.shareWithEmail(artifact.id, body.email, user.id);

    // Only a new share sends an email. Sharing the same artifact with the same
    // person again, which happens when somebody re-opens the dialog and adds a
    // name that is already there, must not send them another one.
    if (isNew && share.notifiedAt === null) {
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

    if (share.userId) {
      notifications.notifyShare({
        recipientUserId: share.userId,
        actor: user,
        artifactId: artifact.id,
      });
    }

    // Anything that was waiting for this person to be let in can go out now.
    // The reason for holding was never the request, it was the lack of access.
    notifications.releaseHeldFor(share.email, artifact.id);

    return c.json({ ...sharing.state(artifact.id), notified: isNew }, isNew ? 201 : 200);
  });

  /** Stop sharing with a person. Takes effect on their next request. */
  app.delete('/api/artifacts/:id/sharing/people/:email', requireUser, (c) => {
    const artifact = ownedArtifact(c.req.param('id'), currentUser(c));
    const email = decodeURIComponent(c.req.param('email'));

    if (!sharing.unshareEmail(artifact.id, email)) {
      throw new ApiError('not_found', 'That artifact is not shared with that address.');
    }
    return c.json(sharing.state(artifact.id));
  });

  /** Share with everybody at a domain. */
  app.post('/api/artifacts/:id/sharing/domains', requireUser, async (c) => {
    const user = currentUser(c);
    const artifact = ownedArtifact(c.req.param('id'), user);
    const body = await readJsonObject(c.req.raw, bodyCap);

    if (typeof body.domain !== 'string') {
      throw new ApiError('validation_failed', 'domain is required.');
    }

    const { isNew } = sharing.shareWithDomain(artifact.id, body.domain, user.id);
    return c.json(sharing.state(artifact.id), isNew ? 201 : 200);
  });

  app.delete('/api/artifacts/:id/sharing/domains/:domain', requireUser, (c) => {
    const artifact = ownedArtifact(c.req.param('id'), currentUser(c));

    if (!sharing.unshareDomain(artifact.id, decodeURIComponent(c.req.param('domain')))) {
      throw new ApiError('not_found', 'That artifact is not shared with that domain.');
    }
    return c.json(sharing.state(artifact.id));
  });

  /** Make it readable by anybody with the link, or stop. */
  app.put('/api/artifacts/:id/sharing/public', requireUser, async (c) => {
    const artifact = ownedArtifact(c.req.param('id'), currentUser(c));
    const body = await readJsonObject(c.req.raw, bodyCap);

    if (typeof body.isPublic !== 'boolean') {
      throw new ApiError('validation_failed', 'isPublic is required and must be true or false.');
    }

    sharing.setPublic(artifact.id, body.isPublic);
    return c.json(sharing.state(artifact.id));
  });

  /**
   * Artifacts other people shared with me.
   *
   * Deliberately not under /api/artifacts/, where it would collide with
   * /api/artifacts/:id and be matched as an artifact called "shared-with-me".
   * Depending on which route was registered first is the kind of thing that
   * works until somebody reorders the file.
   */
  app.get('/api/shared-with-me', requireUser, (c) => {
    const user = currentUser(c);
    const starred = artifacts.starredArtifactIdsFor(user.id);

    return c.json({
      artifacts: sharing.sharedWith(user).map((artifact) => ({
        id: artifact.id,
        slug: artifact.slug,
        ownerId: artifact.ownerId,
        ownerName: context.auth.findUserById(artifact.ownerId)?.displayName ?? null,
        ownerEmail: context.auth.findUserById(artifact.ownerId)?.email ?? null,
        type: artifact.type,
        title: artifact.title,
        version: artifact.currentVersion,
        url: `${config.baseUrl}/a/${artifact.slug}`,
        starred: starred.has(artifact.id),
        createdAt: artifact.createdAt,
        updatedAt: artifact.updatedAt,
      })),
    });
  });
}


