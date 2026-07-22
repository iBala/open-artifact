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
import { registerHealthRoutes } from './routes/health.js';
import { registerAuthRoutes } from './routes/auth.js';
import { AuthService } from '../auth/service.js';
import { createMailer, type Mailer } from '../mail/mailer.js';
import { attachUser } from './session.js';
import type { UserRow } from '../db/schema.js';

export interface AppDependencies {
  config: Config;
  database: DatabaseHandle;
  logger?: Logger;
  /** Overridden in tests so no mail leaves the process. */
  mailer?: Mailer;
}

export interface AppContext {
  config: Config;
  database: DatabaseHandle;
  artifacts: ArtifactService;
  auth: AuthService;
  mailer: Mailer;
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
}: AppDependencies): Hono<AppEnv> {
  const context: AppContext = {
    config,
    database,
    logger,
    mailer,
    artifacts: new ArtifactService({ db: database.db, maxArtifactBytes: config.maxArtifactBytes }),
    auth: new AuthService({
      db: database.db,
      signupMode: config.signupMode,
      signupAllowedDomains: config.signupAllowedDomains,
    }),
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

  registerHealthRoutes(app, context);
  registerAuthRoutes(app, context);
  registerArtifactRoutes(app, context);
  registerViewRoutes(app, context);

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
