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
import { createMemoryMailer, type MemoryMailer } from '@open-artifact/server/mail';

/** The shape Playwright's addCookies wants, without importing Playwright here. */
export interface BrowserCookie {
  name: string;
  value: string;
  url: string;
}

export interface PublishedArtifact {
  id: string;
  slug: string;
  url: string;
  title: string;
  version: number;
  ownerId: string;
}

export interface RunningServer {
  baseUrl: string;
  /** The session cookie of the person these tests act as, as "name=value". */
  sessionCookie: string;
  /** Just the secret half of it, for tests that check it cannot be stolen. */
  sessionValue: string;
  /** Publishes an artifact owned by that person. */
  publish: (body: {
    type: 'markdown' | 'html';
    content: string;
    title?: string;
  }) => Promise<PublishedArtifact>;
  /** Makes a request as that person, the way their browser would. */
  as: (path: string, init?: RequestInit) => Promise<Response>;
  /** Gives a Playwright browser context that person's session. */
  signInBrowser: (context: { addCookies: (cookies: BrowserCookie[]) => Promise<void> }) => Promise<void>;
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
    SIGNUP_MODE: 'open',
    DATABASE_PATH: join(directory, 'e2e.db'),
    LOG_LEVEL: 'error',
  });

  const database = openDatabase({ path: config.databasePath });
  const mailer = createMemoryMailer();
  const app = createApp({ config, database, logger: silentLogger(), mailer });

  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const started = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () =>
      resolve(started),
    );
  });

  // Sign somebody in through the real flow, reading the link out of the mailer.
  const sessionCookie = await signInThroughTheRealFlow(baseUrl, mailer);

  const as = (path: string, init: RequestInit = {}) =>
    fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { Cookie: sessionCookie, ...(init.headers ?? {}) },
    });

  return {
    baseUrl,
    sessionCookie,
    sessionValue: sessionCookie.split('=').slice(1).join('='),
    as,
    signInBrowser: async (context) => {
      const [name, ...rest] = sessionCookie.split('=');
      await context.addCookies([{ name: name ?? '', value: rest.join('='), url: baseUrl }]);
    },
    publish: async (body) => {
      const response = await as('/api/artifacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`publish failed: ${await response.text()}`);
      return (await response.json()) as PublishedArtifact;
    },
    stop: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      database.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

export const E2E_USER_EMAIL = 'e2e-owner@example.com';

/**
 * Signs the test's person in the way a real person would: ask for a link, read
 * it out of the email, follow it. Nothing about authentication is stubbed, so
 * these tests would notice if sign-in broke.
 */
async function signInThroughTheRealFlow(
  baseUrl: string,
  mailer: MemoryMailer,
): Promise<string> {
  const requested = await fetch(`${baseUrl}/api/auth/magic-link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: E2E_USER_EMAIL }),
  });
  if (!requested.ok) throw new Error(`could not request a sign-in link: ${await requested.text()}`);

  const email = mailer.lastTo(E2E_USER_EMAIL);
  const match = email && /https?:\/\/\S*\/auth\/verify\?token=[^\s<"]+/.exec(email.text);
  if (!match) throw new Error('no sign-in link arrived');

  const verified = await fetch(match[0], { redirect: 'manual' });
  const cookie = verified.headers.get('set-cookie');
  if (!cookie) throw new Error(`sign-in did not set a cookie: ${verified.status}`);
  return cookie.split(';')[0] ?? '';
}
