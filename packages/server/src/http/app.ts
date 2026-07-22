/**
 * The HTTP application.
 *
 * Built as a factory so tests construct an app over a throwaway database with no
 * network, no ports and no global state. Everything the app needs arrives here as
 * an argument.
 */

import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import type { Config } from '../config.js';
import type { DatabaseHandle } from '../db/index.js';
import { ArtifactService } from '../artifacts/service.js';
import { ApiError } from '../errors.js';
import { type Logger, silentLogger } from '../logging.js';
import { registerArtifactRoutes } from './routes/artifacts.js';
import { registerViewRoutes } from './routes/view.js';
import { registerLeavingRoutes } from './routes/leaving.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerDeviceRoutes } from './routes/device.js';
import { registerAccountRoutes } from './routes/account.js';
import { registerWebAppRoutes } from './routes/web-app.js';
import { registerSharingRoutes } from './routes/sharing.js';
import { registerCommentRoutes } from './routes/comments.js';
import { registerNotificationRoutes } from './routes/notifications.js';
import { NotificationService } from '../notifications/service.js';
import { CommentService } from '../comments/service.js';
import { SharingService } from '../artifacts/sharing.js';
import { buildOpenApiDocument } from './openapi.js';
import { AuthService } from '../auth/service.js';
import { DeviceFlowService } from '../auth/device-flow.js';
import { createMailer, type Mailer } from '../mail/mailer.js';
import { createGoogleClient, type GoogleClient } from '../auth/google.js';
import { attachUser } from './session.js';
import { createRateLimiter, type RateLimiter } from './rate-limit.js';
import type { UserRow } from '../db/schema.js';

export interface AppDependencies {
  config: Config;
  database: DatabaseHandle;
  logger?: Logger;
  /** Overridden in tests so no mail leaves the process. */
  mailer?: Mailer;
  /** Overridden in tests so no test ever talks to Google. */
  google?: GoogleClient;
  /**
   * Whether to serve the built web app. Tests that only exercise the API turn
   * this off, so the app's catch-all route does not answer for them.
   */
  serveWebApp?: boolean;
}

export interface AppContext {
  config: Config;
  database: DatabaseHandle;
  artifacts: ArtifactService;
  auth: AuthService;
  devices: DeviceFlowService;
  sharing: SharingService;
  comments: CommentService;
  notifications: NotificationService;
  rateLimiter: RateLimiter;
  mailer: Mailer;
  google: GoogleClient;
  logger: Logger;
}

/** Values middleware attaches to a request, readable by every handler. */
export type AppEnv = {
  Variables: {
    requestId: string;
    logger: Logger;
    /** The signed-in person, if this request carried a valid credential. */
    user?: UserRow;
  };
};

export function createApp({
  config,
  database,
  logger = silentLogger(),
  mailer = createMailer(config.smtp, logger),
  google = config.google ? createGoogleClient(config.google) : unconfiguredGoogleClient(),
  serveWebApp = true,
}: AppDependencies): Hono<AppEnv> {
  const sharing = new SharingService(database.db);
  const comments = new CommentService(database.db);
  const notifications = new NotificationService(database.db);

  const auth = new AuthService({
    db: database.db,
    sessionSecret: config.sessionSecret,
    signupMode: config.signupMode,
    signupAllowedDomains: config.signupAllowedDomains,
    // Invite-only means "somebody has shared something with this address".
    // Wiring it here is what makes that mode mean anything.
    hasPendingInvite: (email) => sharing.hasPendingInvite(email),
    // The moment somebody proves they own an address, everything waiting for
    // that address becomes theirs.
    onEmailVerified: (userId, email) => sharing.attachPendingInvites(userId, email),
  });

  const context: AppContext = {
    config,
    database,
    logger,
    mailer,
    google,
    artifacts: new ArtifactService({
      db: database.db,
      maxArtifactBytes: config.maxArtifactBytes,
      maxArtifactsPerUser: config.limits.artifactsPerUser,
      maxStorageBytesPerUser: config.limits.storageBytesPerUser,
    }),
    auth,
    sharing,
    comments,
    notifications,
    rateLimiter: createRateLimiter(),
    devices: new DeviceFlowService({ db: database.db, auth, baseUrl: config.baseUrl }),
  };

  const app = new Hono<AppEnv>();

  // Request id first: everything logged for a request, including a crash, carries
  // the same id, so an operator can follow one request through the log.
  app.use('*', async (c, next) => {
    const requestId = c.req.header('x-request-id') ?? randomUUID();
    c.set('requestId', requestId);
    c.set('logger', logger.child({ requestId }));
    c.header('x-request-id', requestId);

    const startedAt = performance.now();
    await next();
    c.get('logger').info('request', {
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      status: c.res.status,
      durationMs: Math.round(performance.now() - startedAt),
    });
  });

  // Identify the caller before any route runs, so every handler can just ask.
  app.use('*', attachUser(context.auth));

  // The written-down API. Served so anybody can build their own client, and
  // checked against the registered routes by a test so it cannot quietly go stale.
  app.get('/api/docs', (c) => c.json(buildOpenApiDocument(config.baseUrl)));

  registerHealthRoutes(app, context);
  registerAuthRoutes(app, context);
  registerDeviceRoutes(app, context);
  registerAccountRoutes(app, context);
  registerArtifactRoutes(app, context);
  registerSharingRoutes(app, context);
  registerCommentRoutes(app, context);
  registerNotificationRoutes(app, context);
  registerViewRoutes(app, context);
  registerLeavingRoutes(app, context);

  // Last: everything the server owns is claimed above, so the app's catch-all
  // only sees addresses that belong to the app.
  if (serveWebApp) registerWebAppRoutes(app, context);

  app.notFound((c) =>
    c.json(
      { error: { code: 'not_found', message: 'No such endpoint.' } },
      404,
    ),
  );

  app.onError((error, c) => {
    if (error instanceof ApiError) {
      // Expected failures. Logged at debug so normal 404s do not fill the log.
      c.get('logger')?.debug('request failed', { code: error.code, status: error.status });
      return c.json(error.toResponseBody(), error.status as 400);
    }

    c.get('logger')?.error('unhandled error', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    return c.json(
      {
        error: {
          code: 'internal_error',
          message: 'Something went wrong. The server logs have the details.',
          details: { requestId: c.get('requestId') },
        },
      },
      500,
    );
  });

  return app;
}

/**
 * Stands in when the instance has no Google credentials. The routes refuse the
 * request before ever reaching this, so being called at all is a wiring mistake
 * worth hearing about rather than swallowing.
 */
function unconfiguredGoogleClient(): GoogleClient {
  return {
    exchangeCode: () => {
      throw new Error('Google sign-in is not configured on this instance.');
    },
  };
}
