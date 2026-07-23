import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/run.js';
import { EXIT_CODES } from '../src/errors.js';
import { startInstance, type TestInstance } from './helpers/instance.js';

let instance: TestInstance;
let workspace: string;
let output: string[];
let artifactId: string;

const CONTENT =
  'Revenue is up this quarter, driven by new signups.\n\n' +
  '# Quarterly report\n\n' +
  '## Details\n\n' +
  'The details are here for context and clarity.\n';

beforeEach(async () => {
  instance = await startInstance();
  process.env.OPEN_ARTIFACT_HOME = instance.home;
  workspace = mkdtempSync(join(tmpdir(), 'open-artifact-comments-'));
  output = [];

  await cli('login', '--instance', instance.baseUrl, '--email', 'owner@example.com', '--json');
  await cli(
    'login',
    '--instance',
    instance.baseUrl,
    '--email',
    'owner@example.com',
    '--code',
    instance.emailedCodeFor('owner@example.com'),
    '--json',
  );

  writeFileSync(join(workspace, 'report.md'), CONTENT);
  output = [];
  await cli('publish', join(workspace, 'report.md'), '--json');
  artifactId = String(printedJson().id);
  output = [];
});

afterEach(async () => {
  delete process.env.OPEN_ARTIFACT_HOME;
  rmSync(workspace, { recursive: true, force: true });
  await instance.stop();
});

function cli(...argv: string[]): Promise<number> {
  return run(argv, { print: (line) => output.push(line), printError: () => {}, sleep: async () => {} });
}

function printedJson(): Record<string, unknown> {
  return JSON.parse(output.at(-1) ?? '{}') as Record<string, unknown>;
}

describe('commenting on the whole document', () => {
  it('adds a comment with no position', async () => {
    expect(
      await cli('comments', 'add', artifactId, '--body', 'Nice report overall.', '--json'),
    ).toBe(0);

    const thread = printedJson();
    expect(thread).toMatchObject({
      ok: true,
      status: 'open',
      anchor: { kind: 'document' },
      anchorLost: false,
    });
    expect(thread.comments).toEqual([
      { author: 'owner@example.com', body: 'Nice report overall.', createdAt: expect.any(String) },
    ]);
  });

  it('shows up when listing', async () => {
    await cli('comments', 'add', artifactId, '--body', 'Nice report overall.', '--json');
    output = [];

    expect(await cli('comments', 'list', artifactId, '--json')).toBe(0);
    const threads = printedJson().threads as Record<string, unknown>[];
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ anchor: { kind: 'document' } });
  });
});

describe('commenting on a passage', () => {
  it('anchors under a heading, given its slug id', async () => {
    expect(
      await cli(
        'comments',
        'add',
        artifactId,
        '--body',
        'Can we cite a source for this?',
        '--snippet',
        'The details are here for context and clarity.',
        '--heading',
        'details',
        '--json',
      ),
    ).toBe(0);

    const thread = printedJson();
    expect(thread.anchor).toMatchObject({
      kind: 'text',
      headingId: 'details',
      snippet: 'The details are here for context and clarity.',
      occurrence: 0,
    });
  });

  it('anchors a passage before the first heading, where headingId is null', async () => {
    expect(
      await cli(
        'comments',
        'add',
        artifactId,
        '--body',
        'This number needs a citation.',
        '--snippet',
        'Revenue is up this quarter, driven by new signups.',
        '--json',
      ),
    ).toBe(0);

    const thread = printedJson();
    expect(thread.anchor).toMatchObject({ kind: 'text', headingId: null });
  });

  it('refuses a passage that is too short to anchor reliably', async () => {
    expect(
      await cli('comments', 'add', artifactId, '--body', 'What?', '--snippet', 'The', '--json'),
    ).toBe(EXIT_CODES.usage);
  });

  it('refuses a passage that is not actually in the document', async () => {
    expect(
      await cli(
        'comments',
        'add',
        artifactId,
        '--body',
        'What?',
        '--snippet',
        'This sentence was never written.',
        '--json',
      ),
    ).toBe(EXIT_CODES.usage);
  });
});

describe('replying', () => {
  it('adds a reply that shows up when the thread is listed again', async () => {
    await cli('comments', 'add', artifactId, '--body', 'Nice report overall.', '--json');
    const threadId = String(printedJson().id);
    output = [];

    expect(await cli('comments', 'reply', threadId, '--body', 'Thanks, fixed.', '--json')).toBe(0);
    expect(printedJson()).toMatchObject({
      ok: true,
      threadId,
      author: 'owner@example.com',
      body: 'Thanks, fixed.',
    });
    output = [];

    await cli('comments', 'list', artifactId, '--json');
    const threads = printedJson().threads as { comments: unknown[] }[];
    expect(threads[0]?.comments).toHaveLength(2);
  });
});

describe('resolving and reopening', () => {
  it('marks a thread resolved, and open again', async () => {
    await cli('comments', 'add', artifactId, '--body', 'Nice report overall.', '--json');
    const threadId = String(printedJson().id);
    output = [];

    expect(await cli('comments', 'resolve', threadId, '--json')).toBe(0);
    expect(printedJson()).toMatchObject({ ok: true, status: 'resolved' });
    output = [];

    expect(await cli('comments', 'reopen', threadId, '--json')).toBe(0);
    expect(printedJson()).toMatchObject({ ok: true, status: 'open' });
  });

  it('only shows resolved threads when asked for them', async () => {
    await cli('comments', 'add', artifactId, '--body', 'First.', '--json');
    await cli('comments', 'add', artifactId, '--body', 'Second.', '--json');
    const secondId = String(printedJson().id);
    await cli('comments', 'resolve', secondId, '--json');
    output = [];

    await cli('comments', 'list', artifactId, '--status', 'resolved', '--json');
    const threads = printedJson().threads as { id: string }[];
    expect(threads.map((thread) => thread.id)).toEqual([secondId]);
  });

  it('refuses to settle a thread that is not yours to settle', async () => {
    await cli('comments', 'add', artifactId, '--body', 'Nice report overall.', '--json');
    const threadId = String(printedJson().id);

    await instance.signIn('colleague@example.com');
    await cli('share', artifactId, 'add', 'colleague@example.com', '--json');
    const colleagueHome = mkdtempSync(join(tmpdir(), 'open-artifact-home-colleague-'));
    process.env.OPEN_ARTIFACT_HOME = colleagueHome;
    await cli('login', '--instance', instance.baseUrl, '--email', 'colleague@example.com', '--json');
    await cli(
      'login',
      '--instance',
      instance.baseUrl,
      '--email',
      'colleague@example.com',
      '--code',
      instance.emailedCodeFor('colleague@example.com'),
      '--json',
    );
    output = [];

    // A comment they did not start, on an artifact they do not own.
    expect(await cli('comments', 'resolve', threadId, '--json')).toBe(EXIT_CODES.noAccess);

    process.env.OPEN_ARTIFACT_HOME = instance.home;
    rmSync(colleagueHome, { recursive: true, force: true });
  });
});

describe('reading since a point in time', () => {
  it('only shows what changed since then', async () => {
    await cli('comments', 'add', artifactId, '--body', 'First.', '--json');
    const midpoint = new Date().toISOString();

    await cli('comments', 'add', artifactId, '--body', 'Second.', '--json');
    output = [];

    await cli('comments', 'list', artifactId, '--since', midpoint, '--json');
    const threads = printedJson().threads as { comments: { body: string }[] }[];
    expect(threads).toHaveLength(1);
    expect(threads[0]?.comments[0]?.body).toBe('Second.');
  });

  it('refuses a since that is not a UTC timestamp', async () => {
    expect(await cli('comments', 'list', artifactId, '--since', 'yesterday', '--json')).toBe(
      EXIT_CODES.usage,
    );
  });
});

describe('what the person reading the terminal sees', () => {
  it('shows the anchor snippet and who said what', async () => {
    await cli('comments', 'add', artifactId, '--body', 'Nice report overall.');
    output = [];

    await cli('comments', 'list', artifactId);
    expect(output.join('\n')).toContain('owner@example.com: Nice report overall.');
  });

  it('marks a resolved thread', async () => {
    await cli('comments', 'add', artifactId, '--body', 'Nice report overall.', '--json');
    const threadId = String(printedJson().id);
    await cli('comments', 'resolve', threadId, '--json');
    output = [];

    await cli('comments', 'list', artifactId);
    expect(output.join('\n')).toContain('resolved');
  });

  it('says when nobody has said anything', async () => {
    await cli('comments', 'list', artifactId);
    expect(output.join('\n')).toContain('No comments');
  });
});

describe('mistakes an agent might make', () => {
  it('asks which artifact, when add is given nothing to comment on', async () => {
    expect(await cli('comments', 'add', '--json')).toBe(EXIT_CODES.usage);
  });

  it('asks what the comment says, when body is missing', async () => {
    expect(await cli('comments', 'add', artifactId, '--json')).toBe(EXIT_CODES.usage);
  });

  it('asks which thread, when reply is given nothing', async () => {
    expect(await cli('comments', 'reply', '--body', 'hi', '--json')).toBe(EXIT_CODES.usage);
  });

  it('refuses a subcommand it does not have', async () => {
    expect(await cli('comments', 'delete', artifactId, '--json')).toBe(EXIT_CODES.usage);
  });

  it('reports an artifact that is not yours as no access', async () => {
    expect(await cli('comments', 'list', 'art_not_yours', '--json')).toBe(EXIT_CODES.noAccess);
  });
});
