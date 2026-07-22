/**
 * `open-artifact login`
 *
 * A terminal cannot receive a redirect, so signing in works the way a TV app
 * does: we show a short code and a URL, the person approves in their browser, and
 * we poll until they do. See the server's auth/device-flow.ts for the other half.
 */

import { ApiClient } from '../api.js';
import { CliError } from '../errors.js';
import { saveCredential, normaliseBaseUrl, loadCredential } from '../credentials.js';
import type { CommandContext } from '../context.js';

interface StartedLogin {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresInSeconds: number;
  intervalSeconds: number;
}

interface PollResponse {
  state: 'pending' | 'approved' | 'denied' | 'expired';
  token?: string;
  expiresAt?: string;
}

export interface LoginOptions {
  instance?: string | undefined;
  /** What to call this token on the sessions page. */
  label?: string | undefined;
  /** Skips the wait, for tests. */
  maxWaitMs?: number | undefined;
}

export async function login(
  context: CommandContext,
  options: LoginOptions,
): Promise<Record<string, unknown>> {
  const baseUrl = normaliseBaseUrl(
    options.instance ?? loadCredential()?.baseUrl ?? requireInstance(),
  );
  const client = new ApiClient({ baseUrl, fetchImpl: context.fetchImpl });

  const started = await client.request<StartedLogin>('/api/auth/device', {
    method: 'POST',
    body: JSON.stringify({ label: options.label ?? defaultLabel() }),
  });

  if (!context.json) {
    context.print('');
    context.print(`  Open this page to approve the sign-in:`);
    context.print(`  ${started.verificationUrl}`);
    context.print('');
    context.print(`  It should show this code: ${started.userCode}`);
    context.print('');
    context.print('  Waiting…');
  }

  const credential = await pollUntilAnswered(client, started, context, options.maxWaitMs);
  saveCredential(credential);

  if (!context.json) {
    context.print(`  Signed in as ${credential.email} on ${credential.baseUrl}.`);
    context.print('');
  }

  return {
    ok: true,
    signedIn: true,
    instance: credential.baseUrl,
    email: credential.email,
    expiresAt: credential.expiresAt,
  };
}

async function pollUntilAnswered(
  client: ApiClient,
  started: StartedLogin,
  context: CommandContext,
  maxWaitMs?: number,
): Promise<{
  baseUrl: string;
  token: string;
  email: string;
  expiresAt: string;
  savedAt: string;
}> {
  const deadline = context.now() + (maxWaitMs ?? started.expiresInSeconds * 1000);
  const intervalMs = Math.max(started.intervalSeconds, 1) * 1000;

  while (context.now() < deadline) {
    const result = await pollOnce(client, started.deviceCode);

    if (result.state === 'approved' && result.token) {
      const me = await new ApiClient({
        baseUrl: client.baseUrl,
        token: result.token,
        fetchImpl: context.fetchImpl,
      }).request<{ email: string }>('/api/auth/me');

      return {
        baseUrl: client.baseUrl,
        token: result.token,
        email: me.email,
        expiresAt: result.expiresAt ?? '',
        savedAt: new Date(context.now()).toISOString(),
      };
    }

    if (result.state === 'denied') {
      throw new CliError('notAuthenticated', 'The sign-in was refused in the browser.');
    }
    if (result.state === 'expired') {
      throw new CliError('notAuthenticated', 'The sign-in code expired before it was approved.', {
        hint: 'Run: open-artifact login',
      });
    }

    await context.sleep(intervalMs);
  }

  throw new CliError('notAuthenticated', 'Gave up waiting for the sign-in to be approved.', {
    hint: 'Run: open-artifact login',
  });
}

/**
 * "Still waiting" arrives as 202 and "refused" as 403, which the API client would
 * otherwise turn into errors. Here they are ordinary outcomes, so this one call
 * reads the response itself.
 */
async function pollOnce(client: ApiClient, deviceCode: string): Promise<PollResponse> {
  try {
    return await client.request<PollResponse>('/api/auth/device/token', {
      method: 'POST',
      body: JSON.stringify({ deviceCode }),
    });
  } catch (error) {
    if (error instanceof CliError && error.name_ === 'noAccess') return { state: 'denied' };
    throw error;
  }
}

function requireInstance(): never {
  throw new CliError('usage', 'No instance to sign in to.', {
    hint: 'Run: open-artifact login --instance https://artifacts.example.com',
  });
}

/** Something recognisable on the sessions page, without prying into the machine. */
function defaultLabel(): string {
  return `${process.platform === 'darwin' ? 'macOS' : process.platform} terminal`;
}
