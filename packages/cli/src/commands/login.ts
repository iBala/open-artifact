/**
 * `open-artifact login`
 *
 * Signs in the way the website does: the server emails a six-digit code, and the
 * person types it back in. No browser, no device to approve.
 *
 * It works in two runs on purpose, so it never sits and blocks:
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
 */

import { ApiClient } from '../api.js';
import { CliError } from '../errors.js';
import { saveCredential, normaliseBaseUrl, loadCredential } from '../credentials.js';
import type { CommandContext } from '../context.js';

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
