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

  // API only: these tests are about the API, and the app's catch-all route
  // would otherwise answer for anything they did not expect.
  const app = createApp({ config, database, logger, mailer, google, serveWebApp: false });

  const request = (path: string, init?: RequestInit) =>
    app.request(new Request(`${TEST_BASE_URL}${path}`, init));

  return {
    app,
    config,
    database,
    logger,
    mailer,
    google,
    logLines,
    request,
    close: () => database.close(),
  };
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

export interface PublishedArtifact {
  id: string;
  slug: string;
  url: string;
  title: string;
  type: string;
  version: number;
  ownerId: string;
}

export interface SignedInUser {
  id: string;
  email: string;
  sessionCookie: string;
  /** Sends a request as this person's browser. */
  as: (path: string, init?: RequestInit) => Promise<Response>;
  /** Publishes an artifact owned by this person. */
  publish: (body: {
    type: string;
    content: string;
    title?: string;
  }) => Promise<PublishedArtifact>;
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
  const as = (path: string, init: RequestInit = {}) =>
    server.request(path, { ...init, headers: { Cookie: cookie, ...(init.headers ?? {}) } });

  const me = (await (await as('/api/auth/me')).json()) as { id: string };

  return {
    id: me.id,
    email,
    sessionCookie: cookie,
    as,
    publish: async (body) => {
      const response = await as('/api/artifacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (response.status !== 201) {
        throw new Error(`publish failed: ${response.status} ${await response.text()}`);
      }
      return (await response.json()) as PublishedArtifact;
    },
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
