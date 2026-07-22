/**
 * Test harness: a whole app over an in-memory database, with no ports and no
 * shared state between tests.
 */

import type { Hono } from 'hono';
import { loadConfig, type Config } from '../../src/config.js';
import { openDatabase, type DatabaseHandle } from '../../src/db/index.js';
import { createApp, type AppEnv } from '../../src/http/app.js';
import { createLogger, type Logger } from '../../src/logging.js';

export const TEST_TOKEN = 'test-token-value';
export const TEST_BASE_URL = 'https://artifacts.test';

export interface TestServer {
  app: Hono<AppEnv>;
  config: Config;
  database: DatabaseHandle;
  logger: Logger;
  /** Every line the server logged, as parsed objects. */
  logLines: Record<string, unknown>[];
  request: (path: string, init?: RequestInit) => Promise<Response>;
  /** A request carrying the write token. */
  authed: (path: string, init?: RequestInit) => Promise<Response>;
  close: () => void;
}

export function createTestServer(env: Record<string, string | undefined> = {}): TestServer {
  const config = loadConfig({
    BASE_URL: TEST_BASE_URL,
    SESSION_SECRET: 'test-session-secret-that-is-long-enough',
    DEV_API_TOKEN: TEST_TOKEN,
    NODE_ENV: 'test',
    ...env,
  });

  const database = openDatabase({ path: ':memory:' });
  const logLines: Record<string, unknown>[] = [];
  const logger = createLogger({
    level: 'debug',
    write: (line) => logLines.push(JSON.parse(line) as Record<string, unknown>),
  });

  const app = createApp({ config, database, logger });

  const request = (path: string, init?: RequestInit) =>
    app.request(new Request(`${TEST_BASE_URL}${path}`, init));

  const authed = (path: string, init: RequestInit = {}) =>
    request(path, {
      ...init,
      headers: { Authorization: `Bearer ${TEST_TOKEN}`, ...(init.headers ?? {}) },
    });

  return {
    app,
    config,
    database,
    logger,
    logLines,
    request,
    authed,
    close: () => database.close(),
  };
}

/** Publishes an artifact and returns the created record. */
export async function publish(
  server: TestServer,
  body: { type: string; content: string; title?: string },
): Promise<{ id: string; slug: string; url: string; title: string; version: number }> {
  const response = await server.authed('/api/artifacts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (response.status !== 201) {
    throw new Error(`publish failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as never;
}

export function jsonBody(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
