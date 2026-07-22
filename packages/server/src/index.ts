/**
 * Server entry point.
 *
 * Boot order matters: read and validate config, open the database and run
 * migrations, then start listening. A server that has started listening has
 * already proven its configuration and its database are good, so a misconfigured
 * instance fails at startup with a readable message instead of failing on a
 * reader's first request.
 */

import { serve } from '@hono/node-server';
import { loadConfig, ConfigError } from './config.js';
import { openDatabase } from './db/index.js';
import { createApp } from './http/app.js';
import { createLogger } from './logging.js';

export function start(): { stop: () => Promise<void>; port: number } {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`\nOpen Artifact cannot start.\n\n${error.message}\n\n`);
      process.exit(1);
    }
    throw error;
  }

  const logger = createLogger({ level: config.logLevel });
  const database = openDatabase({ path: config.databasePath });
  const app = createApp({ config, database, logger });

  const server = serve({ fetch: app.fetch, port: config.port });
  logger.info('server started', {
    port: config.port,
    baseUrl: config.baseUrl,
    signupMode: config.signupMode,
    googleSignIn: config.google !== null,
  });

  const stop = async (): Promise<void> => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    database.close();
    logger.info('server stopped');
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void stop().then(() => process.exit(0));
    });
  }

  return { stop, port: config.port };
}

// Only start when run directly, so tests can import this module freely.
if (process.argv[1]?.endsWith('index.js') || process.argv[1]?.endsWith('index.ts')) {
  start();
}
