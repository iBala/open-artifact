/**
 * A real Open Artifact server, in process, for CLI tests.
 *
 * The CLI talks to it over real HTTP with a real token. Nothing about the client
 * is stubbed, so these tests would notice if the CLI and the server stopped
 * agreeing about anything.
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
import { createMemoryMailer, type MemoryMailer } from '@open-artifact/server/mail';

export interface TestInstance {
  baseUrl: string;
  mailer: MemoryMailer;
  /** Where the CLI keeps credentials during this test. Never a real home directory. */
  home: string;
  /** Signs somebody in through the browser flow and returns their session cookie. */
  signIn: (email: string) => Promise<string>;
  /** Approves a pending CLI sign-in, the way the browser page does. */
  approveDeviceCode: (userCode: string, sessionCookie: string) => Promise<Response>;
  /**
   * The code a waiting CLI is showing. Read from the server rather than scraped
   * from the CLI's output, so these tests do not break when the wording changes.
   */
  waitForPendingCode: () => Promise<string>;
  /** Closes the HTTP server but leaves the credentials directory alone, for
   *  tests about what happens when an instance goes away. */
  stopServer: () => Promise<void>;
  stop: () => Promise<void>;
}

export async function startInstance(
  env: Record<string, string | undefined> = {},
): Promise<TestInstance> {
  const directory = mkdtempSync(join(tmpdir(), 'open-artifact-cli-'));
  const home = mkdtempSync(join(tmpdir(), 'open-artifact-home-'));

  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  const config = loadConfig({
    NODE_ENV: 'test',
    BASE_URL: baseUrl,
    SESSION_SECRET: 'cli-test-session-secret-long-enough',
    SIGNUP_MODE: 'open',
    DATABASE_PATH: join(directory, 'cli.db'),
    LOG_LEVEL: 'error',
    ...env,
  });

  const database = openDatabase({ path: config.databasePath });
  const mailer = createMemoryMailer();
  const app = createApp({ config, database, logger: silentLogger(), mailer });

  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const started = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () =>
      resolve(started),
    );
  });

  return {
    baseUrl,
    mailer,
    home,
    signIn: async (email) => {
      await fetch(`${baseUrl}/api/auth/magic-link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });

      const message = mailer.lastTo(email);
      const link = message && /https?:\/\/\S*\/auth\/verify\?token=[^\s<"]+/.exec(message.text);
      if (!link) throw new Error(`no sign-in link arrived for ${email}`);

      const verified = await fetch(link[0], { redirect: 'manual' });
      const cookie = verified.headers.get('set-cookie');
      if (!cookie) throw new Error(`sign-in failed with ${verified.status}`);
      return cookie.split(';')[0] ?? '';
    },
    waitForPendingCode: async () => {
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const row = database.raw
          .prepare(
            'select user_code from device_codes where approved_at is null and denied_at is null order by created_at desc limit 1',
          )
          .get() as { user_code: string } | undefined;
        if (row) return row.user_code;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error('no CLI sign-in was ever started');
    },
    approveDeviceCode: (userCode, sessionCookie) =>
      fetch(`${baseUrl}/api/auth/device/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
        body: JSON.stringify({ userCode }),
      }),
    stopServer: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    stop: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      database.close();
      rmSync(directory, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    },
  };
}

async function findFreePort(): Promise<number> {
  const probe = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const server = serve(
      { fetch: () => new Response(null, { status: 503 }), port: 0, hostname: '127.0.0.1' },
      () => resolve(server),
    );
  });
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}
