/**
 * `open-artifact logout` and `open-artifact whoami`.
 */

import { ApiClient } from '../api.js';
import { CliError, notAuthenticated } from '../errors.js';
import { forgetCredential, loadCredential, listCredentials } from '../credentials.js';
import type { CommandContext } from '../context.js';

export interface InstanceOption {
  instance?: string | undefined;
}

/**
 * Signing out revokes the token on the server first, then deletes it locally.
 *
 * That order matters. If the server call fails, the local file is still removed,
 * because leaving a token on disk that the person believes is gone is the worse
 * of the two failures. The command says what happened either way.
 */
export async function logout(
  context: CommandContext,
  options: InstanceOption,
): Promise<Record<string, unknown>> {
  const credential = loadCredential(options.instance);
  if (!credential) {
    if (!context.json) context.print('  You were not signed in.');
    return { ok: true, signedOut: false, reason: 'was not signed in' };
  }

  let revoked = true;
  let reason: string | null = null;
  try {
    await new ApiClient({
      baseUrl: credential.baseUrl,
      token: credential.token,
      fetchImpl: context.fetchImpl,
    }).request('/api/auth/token/revoke', { method: 'POST', expectNoContent: true });
  } catch (error) {
    revoked = false;
    reason = error instanceof Error ? error.message : String(error);
  }

  forgetCredential(credential.baseUrl);

  if (!context.json) {
    context.print(`  Signed out of ${credential.baseUrl}.`);
    if (!revoked) {
      context.print('  The server could not be reached, so the token was removed from this');
      context.print('  machine only. Revoke it from the sessions page if that matters.');
    }
  }

  return {
    ok: true,
    signedOut: true,
    instance: credential.baseUrl,
    revokedOnServer: revoked,
    ...(reason ? { revokeFailure: reason } : {}),
  };
}

export async function whoami(
  context: CommandContext,
  options: InstanceOption,
): Promise<Record<string, unknown>> {
  const credential = loadCredential(options.instance);
  if (!credential) throw notAuthenticated(options.instance);

  const client = new ApiClient({
    baseUrl: credential.baseUrl,
    token: credential.token,
    fetchImpl: context.fetchImpl,
  });

  const me = await client.request<{ id: string; email: string; displayName: string | null }>(
    '/api/auth/me',
  );

  if (!context.json) {
    context.print(`  ${me.email}`);
    context.print(`  on ${credential.baseUrl}`);

    const others = listCredentials().filter((entry) => entry.baseUrl !== credential.baseUrl);
    if (others.length > 0) {
      context.print('');
      context.print(`  Also signed in to: ${others.map((entry) => entry.baseUrl).join(', ')}`);
    }
  }

  return {
    ok: true,
    instance: credential.baseUrl,
    id: me.id,
    email: me.email,
    displayName: me.displayName,
    tokenExpiresAt: credential.expiresAt,
  };
}

/** Used by commands that need a signed-in client. */
export function clientFor(context: CommandContext, instance?: string | undefined): ApiClient {
  const credential = loadCredential(instance);
  if (!credential) throw notAuthenticated(instance);
  return new ApiClient({
    baseUrl: credential.baseUrl,
    token: credential.token,
    fetchImpl: context.fetchImpl,
  });
}

export { CliError };
