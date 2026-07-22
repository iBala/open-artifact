/**
 * `open-artifact publish <file>` and `open-artifact delete <id>`.
 *
 * Publishing is the command that matters most, because it is the one an agent
 * runs unattended. Two decisions follow from that:
 *
 * - The file's extension decides the type. An agent should not have to say
 *   "this .md file is markdown".
 * - Updating an existing artifact reads its current version first and sends that
 *   as the base. If somebody else changed it in between, the server refuses and
 *   the agent is told, rather than silently overwriting their work.
 */

import { readFileSync, statSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { artifactTypeForExtension } from '@open-artifact/shared';
import { CliError } from '../errors.js';
import { clientFor } from './session.js';
import type { CommandContext } from '../context.js';

interface Artifact {
  id: string;
  slug: string;
  ownerId: string;
  type: string;
  title: string;
  version: number;
  url: string;
  createdAt: string;
  updatedAt: string;
  content?: string;
}

export interface PublishOptions {
  file: string | undefined;
  /** Update this artifact instead of creating a new one. */
  id?: string | undefined;
  title?: string | undefined;
  instance?: string | undefined;
}

export async function publish(
  context: CommandContext,
  options: PublishOptions,
): Promise<Record<string, unknown>> {
  if (!options.file) {
    throw new CliError('usage', 'Which file should be published?', {
      hint: 'Run: open-artifact publish report.md',
    });
  }

  const { content, type } = readArtifactFile(options.file);
  const client = clientFor(context, options.instance);

  const artifact = options.id
    ? await update(client, options.id, { content, type, title: options.title })
    : await client.request<Artifact>('/api/artifacts', {
        method: 'POST',
        body: JSON.stringify({
          type,
          content,
          ...(options.title ? { title: options.title } : {}),
        }),
      });

  if (!context.json) {
    context.print('');
    context.print(`  ${artifact.title}`);
    context.print(`  ${artifact.url}`);
    context.print('');
  }

  return {
    ok: true,
    id: artifact.id,
    url: artifact.url,
    title: artifact.title,
    type: artifact.type,
    version: artifact.version,
    updated: options.id !== undefined,
  };
}

async function update(
  client: ReturnType<typeof clientFor>,
  id: string,
  input: { content: string; type: string; title: string | undefined },
): Promise<Artifact> {
  // Read first, so the update carries the version it is actually based on.
  // Without this the CLI would have to guess, and guessing is how one agent
  // silently overwrites another.
  const current = await client.request<Artifact>(`/api/artifacts/${id}`);

  return client.request<Artifact>(`/api/artifacts/${id}`, {
    method: 'PUT',
    body: JSON.stringify({
      content: input.content,
      type: input.type,
      baseVersion: current.version,
      ...(input.title ? { title: input.title } : {}),
    }),
  });
}

export interface DeleteOptions {
  id: string | undefined;
  confirm: boolean;
  instance?: string | undefined;
}

export async function deleteArtifact(
  context: CommandContext,
  options: DeleteOptions,
): Promise<Record<string, unknown>> {
  if (!options.id) {
    throw new CliError('usage', 'Which artifact should be deleted?', {
      hint: 'Run: open-artifact delete art_xxx --confirm',
    });
  }

  if (!options.confirm) {
    // An agent should never delete somebody's work because an id was slightly
    // wrong. Saying so is cheap; the alternative is not recoverable.
    throw new CliError('usage', 'Deleting is permanent, so it has to be asked for explicitly.', {
      hint: `Run: open-artifact delete ${options.id} --confirm`,
    });
  }

  const client = clientFor(context, options.instance);
  await client.request(`/api/artifacts/${options.id}?confirm=true`, {
    method: 'DELETE',
    expectNoContent: true,
  });

  if (!context.json) context.print(`  Deleted ${options.id}.`);
  return { ok: true, deleted: true, id: options.id };
}

export async function list(
  context: CommandContext,
  options: { instance?: string | undefined },
): Promise<Record<string, unknown>> {
  const client = clientFor(context, options.instance);
  const response = await client.request<{ artifacts: Artifact[] }>('/api/artifacts');

  if (!context.json) {
    if (response.artifacts.length === 0) {
      context.print('  You have not published anything yet.');
    } else {
      context.print('');
      for (const artifact of response.artifacts) {
        context.print(`  ${artifact.title}`);
        context.print(`    ${artifact.id}  ${artifact.url}`);
      }
      context.print('');
    }
  }

  return {
    ok: true,
    artifacts: response.artifacts.map((artifact) => ({
      id: artifact.id,
      title: artifact.title,
      type: artifact.type,
      url: artifact.url,
      version: artifact.version,
      updatedAt: artifact.updatedAt,
    })),
  };
}

/** Reads the file and works out what kind of artifact it is. */
function readArtifactFile(path: string): { content: string; type: string } {
  const fullPath = resolve(path);

  const type = artifactTypeForExtension(extname(fullPath));
  if (!type) {
    throw new CliError(
      'unsupportedType',
      `Artifacts are Markdown or HTML. "${basename(fullPath)}" is neither.`,
      { hint: 'Rename it to .md or .html, or publish a different file.' },
    );
  }

  try {
    if (statSync(fullPath).isDirectory()) {
      throw new CliError('fileNotFound', `"${path}" is a directory, not a file.`);
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError('fileNotFound', `There is no file at "${path}".`);
  }

  try {
    return { content: readFileSync(fullPath, 'utf8'), type };
  } catch {
    throw new CliError('fileNotFound', `Could not read "${path}".`);
  }
}
