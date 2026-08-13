/**
 * `open-artifact login`
 *
 * Most instances sign in the way the website does: the server emails a
 * six-digit code, and the person types it back in. That flow works in two runs
 * on purpose, so it never sits and blocks:
 *
 *   open-artifact login --instance URL --email me@example.com
 *     sends the code and stops. It does not wait.
 *
 *   open-artifact login --email me@example.com --code 123456
 *     hands the code back for a token, and saves it.
 *
 * The two runs matter most when an assistant is driving this. A command that
 * waited for input would freeze the assistant; instead it does one thing, exits,
 * and the assistant can ask the person for the code before the second run.
 *
 * An instance that delegates sign-in to a proxy in front of it has no email
 * code to send — `/api/auth/methods` says so — so this falls back
 * to the device flow instead: print a URL and a short code, have a person open
 * it and approve in a browser they are already signed into there, and poll
 * until they do. That one *does* block, the same way `gh auth login` or
 * `flyctl auth login` do, because there is no code to hand back on a second run.
 */

import { ApiClient } from '../api.js';
import { CliError } from '../errors.js';
import { saveCredential, normaliseBaseUrl, loadCredential } from '../credentials.js';
import type { CommandContext } from '../context.js';

interface AuthMethods {
  emailCode: boolean;
}

interface StartedDeviceLogin {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresInSeconds: number;
  intervalSeconds: number;
}

type DevicePollResult =
  | { state: 'pending' }
  | { state: 'approved'; token: string; expiresAt: string; email: string };

export interface LoginOptions {
  instance?: string | undefined;
  /** What to call this token on the sessions page. */
  label?: string | undefined;
  /** Who is signing in. Required; there is no browser to ask. */
  email?: string | undefined;
  /** The code from the email. Its presence is what turns "send" into "finish". */
  code?: string | undefined;
}

interface CliToken {
  token: string;
  email: string;
  expiresAt: string;
  isNewAccount: boolean;
}

export async function login(
  context: CommandContext,
  options: LoginOptions,
): Promise<Record<string, unknown>> {
  const baseUrl = normaliseBaseUrl(
    options.instance ?? loadCredential()?.baseUrl ?? requireInstance(),
  );
  const client = new ApiClient({ baseUrl, fetchImpl: context.fetchImpl });

  const methods = await client.request<AuthMethods>('/api/auth/methods');
  if (!methods.emailCode) {
    return loginWithDeviceFlow(context, client, baseUrl, options);
  }

  const email = options.email ?? requireEmail();

  // No code yet: send one and stop. The caller comes back with --code.
  if (!options.code) {
    await client.request('/api/auth/code', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });

    if (!context.json) {
      context.print('');
      context.print(`  A sign-in code is on its way to ${email}.`);
      context.print('  When it arrives, finish signing in with:');
      context.print('');
      context.print(`    open-artifact login --instance ${baseUrl} --email ${email} --code THE_CODE`);
      context.print('');
    }

    return { ok: true, codeSent: true, instance: baseUrl, email };
  }

  // Code in hand: exchange it for a token and save it.
  const result = await client.request<CliToken>('/api/auth/cli-token', {
    method: 'POST',
    body: JSON.stringify({ email, code: options.code, label: options.label ?? defaultLabel() }),
  });

  saveCredential({
    baseUrl,
    token: result.token,
    email: result.email,
    expiresAt: result.expiresAt,
    savedAt: new Date(context.now()).toISOString(),
  });

  if (!context.json) {
    context.print('');
    context.print(`  Signed in as ${result.email} on ${baseUrl}.`);
    context.print('');
  }

  return {
    ok: true,
    signedIn: true,
    instance: baseUrl,
    email: result.email,
    expiresAt: result.expiresAt,
  };
}

/**
 * The device flow: ask for a code, print it, poll until a browser approves it.
 * Blocks for as long as the code is valid, because unlike the emailed code
 * there is nothing to hand back on a second run — the approval happens in
 * somebody's browser, not in this process.
 */
async function loginWithDeviceFlow(
  context: CommandContext,
  client: ApiClient,
  baseUrl: string,
  options: LoginOptions,
): Promise<Record<string, unknown>> {
  const started = await client.request<StartedDeviceLogin>('/api/auth/device', {
    method: 'POST',
    body: JSON.stringify({ label: options.label ?? defaultLabel() }),
  });

  if (!context.json) {
    context.print('');
    context.print('  Open this URL in a browser to sign in:');
    context.print('');
    context.print(`    ${started.verificationUrl}`);
    context.print('');
    context.print(`  Check the page shows this code before approving: ${started.userCode}`);
    context.print('');
  }

  const deadline = context.now() + started.expiresInSeconds * 1000;

  while (context.now() < deadline) {
    await context.sleep(started.intervalSeconds * 1000);

    let polled: DevicePollResult;
    try {
      polled = await client.request<DevicePollResult>('/api/auth/device/token', {
        method: 'POST',
        body: JSON.stringify({ deviceCode: started.deviceCode }),
      });
    } catch (error) {
      // The server answers a denied or expired code with a status this client
      // otherwise treats as a generic failure; read those two back out and give
      // them their own message. Anything else — the instance going away, say —
      // is a real failure and is left to propagate as one.
      if (error instanceof CliError && error.name_ === 'noAccess') {
        throw new CliError('noAccess', 'Sign-in was refused in the browser.');
      }
      if (error instanceof CliError && error.name_ === 'serverError') {
        throw new CliError('usage', 'That sign-in link expired before it was approved.', {
          hint: 'Run open-artifact login again.',
        });
      }
      throw error;
    }

    if (polled.state === 'pending') continue;

    saveCredential({
      baseUrl,
      token: polled.token,
      email: polled.email,
      expiresAt: polled.expiresAt,
      savedAt: new Date(context.now()).toISOString(),
    });

    if (!context.json) {
      context.print(`  Signed in as ${polled.email} on ${baseUrl}.`);
      context.print('');
    }

    return {
      ok: true,
      signedIn: true,
      instance: baseUrl,
      email: polled.email,
      expiresAt: polled.expiresAt,
    };
  }

  throw new CliError('usage', 'Nobody approved that sign-in before it expired.', {
    hint: 'Run open-artifact login again.',
  });
}

function requireInstance(): never {
  throw new CliError('usage', 'No instance to sign in to.', {
    hint: 'Run: open-artifact login --instance https://artifacts.example.com --email you@example.com',
  });
}

function requireEmail(): never {
  throw new CliError('usage', 'An email address is needed to sign in.', {
    hint: 'Run: open-artifact login --email you@example.com',
  });
}

/** Something recognisable on the sessions page, without prying into the machine. */
function defaultLabel(): string {
  return `${process.platform === 'darwin' ? 'macOS' : process.platform} terminal`;
}
