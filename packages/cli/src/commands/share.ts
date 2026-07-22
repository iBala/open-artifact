/**
 * `open-artifact share <id> ...`
 *
 * Everything about who can see an artifact, in one command with subcommands, so
 * an agent has one thing to learn rather than five.
 */

import { CliError } from '../errors.js';
import { clientFor } from './session.js';
import type { CommandContext } from '../context.js';

interface SharingState {
  artifactId: string;
  isPublic: boolean;
  people: { id: string; email: string; pending: boolean; createdAt: string }[];
  domains: { id: string; domain: string; createdAt: string }[];
}

export interface ShareOptions {
  id: string | undefined;
  /** show | add | remove | public | private */
  action: string;
  /** An email address or a domain, for add and remove. */
  target?: string | undefined;
  instance?: string | undefined;
}

export async function share(
  context: CommandContext,
  options: ShareOptions,
): Promise<Record<string, unknown>> {
  if (!options.id) {
    throw new CliError('usage', 'Which artifact?', {
      hint: 'Run: open-artifact share art_xxx show',
    });
  }

  const client = clientFor(context, options.instance);
  const base = `/api/artifacts/${options.id}/sharing`;

  let state: SharingState;

  switch (options.action) {
    case 'show':
      state = await client.request<SharingState>(base);
      break;

    case 'add':
      state = await client.request<SharingState>(
        looksLikeEmail(requireTarget(options)) ? `${base}/people` : `${base}/domains`,
        {
          method: 'POST',
          body: JSON.stringify(
            looksLikeEmail(requireTarget(options))
              ? { email: options.target }
              : { domain: options.target },
          ),
        },
      );
      break;

    case 'remove':
      state = await client.request<SharingState>(
        looksLikeEmail(requireTarget(options))
          ? `${base}/people/${encodeURIComponent(options.target ?? '')}`
          : `${base}/domains/${encodeURIComponent(options.target ?? '')}`,
        { method: 'DELETE' },
      );
      break;

    case 'public':
    case 'private':
      state = await client.request<SharingState>(`${base}/public`, {
        method: 'PUT',
        body: JSON.stringify({ isPublic: options.action === 'public' }),
      });
      break;

    default:
      throw new CliError('usage', `"${options.action}" is not something share can do.`, {
        hint: 'Use: show, add, remove, public or private.',
      });
  }

  if (!context.json) printState(context, state);

  return {
    ok: true,
    artifactId: state.artifactId,
    isPublic: state.isPublic,
    people: state.people.map((person) => ({ email: person.email, pending: person.pending })),
    domains: state.domains.map((entry) => entry.domain),
  };
}

function requireTarget(options: ShareOptions): string {
  if (!options.target) {
    throw new CliError('usage', 'Share with whom?', {
      hint: `Run: open-artifact share ${options.id} ${options.action} colleague@example.com`,
    });
  }
  return options.target;
}

/** An address has an @; a domain does not. That is the whole distinction. */
function looksLikeEmail(target: string): boolean {
  return target.includes('@') && !target.startsWith('@');
}

function printState(context: CommandContext, state: SharingState): void {
  context.print('');
  context.print(state.isPublic ? '  Public: anybody with the link can read it.' : '  Private.');

  if (state.people.length > 0) {
    context.print('');
    context.print('  Shared with:');
    for (const person of state.people) {
      context.print(`    ${person.email}${person.pending ? '  (has not signed in yet)' : ''}`);
    }
  }

  if (state.domains.length > 0) {
    context.print('');
    context.print('  Shared with everybody at:');
    for (const entry of state.domains) context.print(`    ${entry.domain}`);
  }

  if (state.people.length === 0 && state.domains.length === 0 && !state.isPublic) {
    context.print('  Nobody else can see it.');
  }
  context.print('');
}
