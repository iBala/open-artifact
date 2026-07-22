/**
 * Test harness: a whole app over an in-memory database, with no ports, no mail
 * leaving the process, and no shared state between tests.
 */

import type { Hono } from 'hono';
import { loadConfig, type Config } from '../../src/config.js';
import { openDatabase, type DatabaseHandle } from '../../src/db/index.js';
import { createApp, type AppEnv } from '../../src/http/app.js';
import { createLogger, type Logger } from '../../src/logging.js';
import { createMemoryMailer, type MemoryMailer } from '../../src/mail/mailer.js';
import type { GoogleClient, GoogleIdentity } from '../../src/auth/google.js';

export const TEST_TOKEN = 'test-token-value';
export const TEST_BASE_URL = 'https://artifacts.test';

export interface TestServer {
  app: Hono<AppEnv>;
  config: Config;
  database: DatabaseHandle;
  logger: Logger;
  mailer: MemoryMailer;
  /** The stand-in for Google. Set `nextIdentity` to say who signs in next. */
  google: FakeGoogleClient;
  /** Every line the server logged, as parsed objects. */
  logLines: Record<string, unknown>[];
  request: (path: string, init?: RequestInit) => Promise<Response>;
  /** A request carrying the temporary Sprint 1 write token. */
  authed: (path: string, init?: RequestInit) => Promise<Response>;
  close: () => void;
}

export interface FakeGoogleClient extends GoogleClient {
  /** Who Google will say is signing in. */
  nextIdentity: GoogleIdentity | null;
  /** The codes it was asked to exchange, so tests can check what was sent. */
  readonly exchanged: { code: string; redirectUri: string }[];
}

function createFakeGoogleClient(): FakeGoogleClient {
  const exchanged: { code: string; redirectUri: string }[] = [];
  return {
    nextIdentity: null,
    exchanged,
    async exchangeCode(code, redirectUri) {
      exchanged.push({ code, redirectUri });
      if (!this.nextIdentity) throw new Error('the test did not say who Google should return');
      return this.nextIdentity;
    },
  };
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
  const mailer = createMemoryMailer();
  const google = createFakeGoogleClient();

  const app = createApp({ config, database, logger, mailer, google });

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
    mailer,
    google,
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

// ---------------------------------------------------------------------------
// Signing in, from a test's point of view
// ---------------------------------------------------------------------------

export interface SignedInUser {
  email: string;
  sessionCookie: string;
  /** Sends a request as this person's browser. */
  as: (path: string, init?: RequestInit) => Promise<Response>;
}

/**
 * Goes through the real sign-in flow: ask for a link, read it out of the email,
 * follow it, keep the cookie. Nothing is faked, so these tests also cover the
 * flow itself.
 */
export async function signIn(server: TestServer, email: string): Promise<SignedInUser> {
  const requested = await server.request('/api/auth/magic-link', jsonBody({ email }));
  if (!requested.ok) {
    throw new Error(`could not request a sign-in link: ${await requested.text()}`);
  }

  const link = magicLinkFor(server, email);
  const verified = await server.request(link.pathname + link.search, { redirect: 'manual' });
  if (verified.status !== 302) {
    throw new Error(`sign-in failed: ${verified.status} ${await verified.text()}`);
  }

  const cookie = sessionCookieFrom(verified);
  return {
    email,
    sessionCookie: cookie,
    as: (path, init: RequestInit = {}) =>
      server.request(path, { ...init, headers: { Cookie: cookie, ...(init.headers ?? {}) } }),
  };
}

/** Pulls the sign-in URL out of the most recent email to an address. */
export function magicLinkFor(server: TestServer, email: string): URL {
  const message = server.mailer.lastTo(email);
  if (!message) throw new Error(`no email was sent to ${email}`);

  const match = /https?:\/\/\S*\/auth\/verify\?token=[^\s<"]+/.exec(message.text);
  if (!match) throw new Error(`no sign-in link in the email to ${email}`);
  return new URL(match[0]);
}

export function sessionCookieFrom(response: Response): string {
  const header = response.headers.get('set-cookie');
  if (!header) throw new Error('the response set no cookie');
  return header.split(';')[0] ?? '';
}
