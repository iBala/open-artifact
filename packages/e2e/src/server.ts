/**
 * Starts a real Open Artifact server for a browser test, on a throwaway database
 * and a free port. In-process rather than a spawned container so a failing test
 * points at a stack frame instead of a log file.
 */

import { serve } from '@hono/node-server';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { loadConfig } from '@open-artifact/server/config';
import { openDatabase } from '@open-artifact/server/db';
import { createApp } from '@open-artifact/server/http/app';
import { silentLogger } from '@open-artifact/server/logging';

export const E2E_TOKEN = 'e2e-token';

export interface RunningServer {
  baseUrl: string;
  /** Publishes an artifact and returns its record, including the viewing URL. */
  publish: (body: {
    type: 'markdown' | 'html';
    content: string;
    title?: string;
  }) => Promise<{ id: string; slug: string; url: string; title: string; version: number }>;
  stop: () => Promise<void>;
}

export async function startServer(): Promise<RunningServer> {
  const directory = mkdtempSync(join(tmpdir(), 'open-artifact-e2e-'));

  // Port 0 asks the operating system for any free port, so parallel tests never
  // collide.
  const listener = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const placeholder = { fetch: () => new Response('starting', { status: 503 }) };
    const server = serve({ fetch: placeholder.fetch, port: 0, hostname: '127.0.0.1' }, () =>
      resolve(server),
    );
  });
  const port = (listener.address() as AddressInfo).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));

  const baseUrl = `http://127.0.0.1:${port}`;
  const config = loadConfig({
    NODE_ENV: 'test',
    BASE_URL: baseUrl,
    SESSION_SECRET: 'e2e-session-secret-long-enough-to-pass',
    DEV_API_TOKEN: E2E_TOKEN,
    DATABASE_PATH: join(directory, 'e2e.db'),
    LOG_LEVEL: 'error',
  });

  const database = openDatabase({ path: config.databasePath });
  const app = createApp({ config, database, logger: silentLogger() });

  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const started = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () =>
      resolve(started),
    );
  });

  return {
    baseUrl,
    publish: async (body) => {
      const response = await fetch(`${baseUrl}/api/artifacts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${E2E_TOKEN}`,
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`publish failed: ${await response.text()}`);
      return (await response.json()) as never;
    },
    stop: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      database.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
