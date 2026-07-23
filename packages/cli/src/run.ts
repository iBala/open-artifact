/**
 * Parsing what was typed, and deciding what to print.
 *
 * The `--json` flag is what makes this usable by an agent: exactly one JSON
 * object on stdout and nothing else, whether the command worked or not. Without
 * it, output is written for a person.
 *
 * No argument parsing library. The surface is small, and hand-parsing keeps the
 * error messages ours.
 */

import { CliError } from './errors.js';
import { createCommandContext, type CommandContext } from './context.js';
import { login } from './commands/login.js';
import { logout, whoami } from './commands/session.js';
import { publish, deleteArtifact, list } from './commands/publish.js';
import { share } from './commands/share.js';
import { comments } from './commands/comments.js';

export interface ParsedArguments {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

export function parseArguments(argv: string[]): ParsedArguments {
  const [command = '', ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index] ?? '';

    if (!argument.startsWith('--')) {
      positional.push(argument);
      continue;
    }

    const withoutDashes = argument.slice(2);
    if (withoutDashes.includes('=')) {
      const [name = '', ...value] = withoutDashes.split('=');
      flags[name] = value.join('=');
      continue;
    }

    const next = rest[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[withoutDashes] = next;
      index += 1;
    } else {
      flags[withoutDashes] = true;
    }
  }

  return { command, positional, flags };
}

function stringFlag(flags: Record<string, string | boolean>, name: string): string | undefined {
  const value = flags[name];
  return typeof value === 'string' ? value : undefined;
}

export async function run(
  argv: string[],
  overrides: Partial<CommandContext> = {},
): Promise<number> {
  const parsed = parseArguments(argv);
  const json = parsed.flags.json === true || parsed.flags.json === 'true';
  const context = createCommandContext({ json, ...overrides });

  try {
    const result = await dispatch(parsed, context);
    if (context.json) context.print(JSON.stringify(result));
    return 0;
  } catch (error) {
    const cliError =
      error instanceof CliError
        ? error
        : new CliError(
            'serverError',
            error instanceof Error ? error.message : String(error),
          );

    if (context.json) {
      // The JSON object goes to stdout even on failure, because that is where an
      // agent is reading. Nothing else is written there.
      context.print(JSON.stringify(cliError.toJson()));
    } else {
      context.printError(`\n  ${cliError.message}`);
      if (cliError.hint) context.printError(`  ${cliError.hint}`);
      context.printError('');
    }
    return cliError.exitCode;
  }
}

async function dispatch(
  parsed: ParsedArguments,
  context: CommandContext,
): Promise<Record<string, unknown>> {
  const instance = stringFlag(parsed.flags, 'instance');

  switch (parsed.command) {
    case 'login':
      return login(context, {
        instance,
        label: stringFlag(parsed.flags, 'label'),
        email: stringFlag(parsed.flags, 'email'),
        code: stringFlag(parsed.flags, 'code'),
      });

    case 'logout':
      return logout(context, { instance });

    case 'whoami':
      return whoami(context, { instance });

    case 'publish':
      return publish(context, {
        file: parsed.positional[0],
        id: stringFlag(parsed.flags, 'id'),
        title: stringFlag(parsed.flags, 'title'),
        instance,
      });

    case 'delete':
      return deleteArtifact(context, {
        id: parsed.positional[0],
        confirm: parsed.flags.confirm === true || parsed.flags.confirm === 'true',
        instance,
      });

    case 'list':
      return list(context, { instance });

    case 'share':
      return share(context, {
        id: parsed.positional[0],
        action: parsed.positional[1] ?? 'show',
        target: parsed.positional[2],
        instance,
      });

    case 'comments':
      return comments(context, {
        action: parsed.positional[0] ?? '',
        id: parsed.positional[1],
        since: stringFlag(parsed.flags, 'since'),
        status: stringFlag(parsed.flags, 'status'),
        body: stringFlag(parsed.flags, 'body'),
        heading: stringFlag(parsed.flags, 'heading'),
        snippet: stringFlag(parsed.flags, 'snippet'),
        occurrence: stringFlag(parsed.flags, 'occurrence'),
        instance,
      });

    case 'help':
    case '--help':
    case '-h':
    case '':
      context.print(HELP);
      return { ok: true, help: true };

    case 'version':
    case '--version':
      context.print(VERSION);
      return { ok: true, version: VERSION };

    default:
      throw new CliError('usage', `There is no "${parsed.command}" command.`, {
        hint: 'Run: open-artifact help',
      });
  }
}

const VERSION = '0.2.0';

const HELP = `
  open-artifact — publish and share HTML and Markdown artifacts

  Signing in
    login --instance URL --email YOU        email yourself a sign-in code
    login --email YOU --code CODE           finish signing in with that code
    logout [--instance URL]                 sign out and revoke the token
    whoami [--instance URL]                 show who this machine is signed in as

  Artifacts
    publish FILE [--id ID] [--title TITLE]  publish a .md or .html file, or
                                           update an existing artifact
    list                                    everything you have published
    delete ID --confirm                     delete an artifact, permanently

  Sharing
    share ID show                           who can see it
    share ID add colleague@example.com      share with a person
    share ID add example.com                share with everybody at a domain
    share ID remove colleague@example.com   stop sharing with them
    share ID public                         anybody with the link can read it
    share ID private                        only the people you shared with

  Comments
    comments list ID [--since TS] [--status open|resolved]
                                             everything said about it
    comments add ID --body TEXT [--snippet TEXT] [--heading ID]
                                             say something about it
    comments reply THREAD_ID --body TEXT    reply on a thread
    comments resolve THREAD_ID              mark a thread settled
    comments reopen THREAD_ID               reopen a resolved thread

  Everywhere
    --json            print one JSON object and nothing else
    --instance URL    which server to talk to
`;
