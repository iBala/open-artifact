/**
 * `open-artifact comments ...`
 *
 * This is the feedback loop for an agent: read what somebody said about the
 * artifact, fix it, reply, mark the thread settled. One command with
 * subcommands, the same shape as `share`, so there is one thing to learn.
 *
 * Editing and deleting a comment are deliberately not here. An agent rewriting
 * or erasing its own earlier words in a conversation somebody else is reading
 * is a bad shape, so those stay something a person does in the browser.
 */

import type {
  Comment,
  CommentAnchor,
  CommentThread,
  ListCommentsResponse,
} from '@open-artifact/shared';
import { CliError } from '../errors.js';
import { clientFor } from './session.js';
import type { CommandContext } from '../context.js';

export interface CommentsOptions {
  /** list | add | reply | resolve | reopen */
  action: string;
  /** An artifact id for list/add, a thread id for reply/resolve/reopen. */
  id: string | undefined;
  since?: string | undefined;
  status?: string | undefined;
  body?: string | undefined;
  heading?: string | undefined;
  snippet?: string | undefined;
  occurrence?: string | undefined;
  instance?: string | undefined;
}

export async function comments(
  context: CommandContext,
  options: CommentsOptions,
): Promise<Record<string, unknown>> {
  switch (options.action) {
    case 'list':
      return listThreads(context, options);
    case 'add':
      return addThread(context, options);
    case 'reply':
      return reply(context, options);
    case 'resolve':
      return setStatus(context, options, 'resolved');
    case 'reopen':
      return setStatus(context, options, 'open');
    case '':
      throw new CliError('usage', 'What should comments do?', {
        hint: 'Run: open-artifact comments list art_xxx',
      });
    default:
      throw new CliError('usage', `"${options.action}" is not something comments can do.`, {
        hint: 'Use: list, add, reply, resolve or reopen.',
      });
  }
}

async function listThreads(
  context: CommandContext,
  options: CommentsOptions,
): Promise<Record<string, unknown>> {
  const artifactId = requireArtifactId(options);
  const client = clientFor(context, options.instance);

  const query = new URLSearchParams();
  if (options.status) query.set('status', options.status);
  if (options.since) query.set('since', options.since);
  const queryString = query.toString();

  const response = await client.request<ListCommentsResponse>(
    `/api/artifacts/${artifactId}/comments${queryString ? `?${queryString}` : ''}`,
  );

  if (!context.json) printThreads(context, response.threads);

  return { ok: true, threads: response.threads.map(threadToJson) };
}

async function addThread(
  context: CommandContext,
  options: CommentsOptions,
): Promise<Record<string, unknown>> {
  const artifactId = requireArtifactId(options);
  if (!options.body) {
    throw new CliError('usage', 'What does the comment say?', {
      hint: `Run: open-artifact comments add ${artifactId} --body "Nice work"`,
    });
  }

  // No --snippet means this is about the whole document. --heading only means
  // anything alongside a snippet, and a passage before the first heading has
  // no heading at all, which is exactly what leaving it out means to the API.
  const position = options.snippet
    ? {
        headingId: options.heading ?? null,
        snippet: options.snippet,
        ...(options.occurrence !== undefined
          ? { occurrence: parseOccurrence(options.occurrence) }
          : {}),
      }
    : undefined;

  const client = clientFor(context, options.instance);
  const thread = await client.request<CommentThread>(`/api/artifacts/${artifactId}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body: options.body, ...(position ? { position } : {}) }),
  });

  if (!context.json) {
    context.print('');
    context.print(`  Commented on ${describeAnchor(thread.anchor)}.`);
    context.print(`  ${thread.id}`);
    context.print('');
  }

  return { ok: true, ...threadToJson(thread) };
}

async function reply(
  context: CommandContext,
  options: CommentsOptions,
): Promise<Record<string, unknown>> {
  const threadId = requireThreadId(options);
  if (!options.body) {
    throw new CliError('usage', 'What do you want to say?', {
      hint: `Run: open-artifact comments reply ${threadId} --body "Done, thanks"`,
    });
  }

  const client = clientFor(context, options.instance);
  const comment = await client.request<Comment>(`/api/comments/threads/${threadId}/replies`, {
    method: 'POST',
    body: JSON.stringify({ body: options.body }),
  });

  if (!context.json) context.print(`  Replied on ${threadId}.`);

  return {
    ok: true,
    id: comment.id,
    threadId: comment.threadId,
    author: comment.author?.email ?? null,
    body: comment.body,
    createdAt: comment.createdAt,
  };
}

async function setStatus(
  context: CommandContext,
  options: CommentsOptions,
  status: 'open' | 'resolved',
): Promise<Record<string, unknown>> {
  const threadId = requireThreadId(options);
  const client = clientFor(context, options.instance);

  const thread = await client.request<CommentThread>(`/api/comments/threads/${threadId}/status`, {
    method: 'PUT',
    body: JSON.stringify({ status }),
  });

  if (!context.json) {
    context.print(
      status === 'resolved' ? `  Resolved ${threadId}.` : `  Reopened ${threadId}.`,
    );
  }

  return { ok: true, ...threadToJson(thread) };
}

function requireArtifactId(options: CommentsOptions): string {
  if (!options.id) {
    throw new CliError('usage', 'Which artifact?', {
      hint: `Run: open-artifact comments ${options.action} art_xxx`,
    });
  }
  return options.id;
}

function requireThreadId(options: CommentsOptions): string {
  if (!options.id) {
    throw new CliError('usage', 'Which thread?', {
      hint: `Run: open-artifact comments ${options.action} thr_xxx`,
    });
  }
  return options.id;
}

/** occurrence has to be a whole number from zero, the same rule the server enforces. */
function parseOccurrence(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new CliError('usage', 'occurrence must be a whole number from zero.', {
      hint: 'Leave it out for the first match, or pass --occurrence 1 for the second, and so on.',
    });
  }
  return value;
}

function threadToJson(thread: CommentThread): Record<string, unknown> {
  return {
    id: thread.id,
    status: thread.status,
    anchor: thread.anchor,
    anchorLost: thread.anchorLost,
    comments: thread.comments.map((comment) => ({
      author: comment.author?.email ?? null,
      body: comment.body,
      createdAt: comment.createdAt,
    })),
  };
}

function describeAnchor(anchor: CommentAnchor): string {
  return anchor.kind === 'document' ? 'the whole document' : `"${anchor.snippet}"`;
}

function printThreads(context: CommandContext, threads: CommentThread[]): void {
  if (threads.length === 0) {
    context.print('  No comments.');
    return;
  }

  context.print('');
  for (const thread of threads) {
    const tags = [
      thread.status === 'resolved' ? 'resolved' : null,
      thread.anchorLost ? 'passage no longer found; now about the whole document' : null,
    ].filter((tag): tag is string => tag !== null);

    context.print(
      `  ${describeAnchor(thread.anchor)}${tags.length > 0 ? `  (${tags.join(', ')})` : ''}`,
    );
    for (const comment of thread.comments) {
      context.print(`    ${comment.author?.email ?? '(deleted account)'}: ${comment.body}`);
    }
    context.print(`    ${thread.id}`);
    context.print('');
  }
}
