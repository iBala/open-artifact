import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/run.js';
import { EXIT_CODES } from '../src/errors.js';
import { startInstance, type TestInstance } from './helpers/instance.js';

/**
 * Publishing from the command line, against a real server.
 *
 * Half of these are about failing well. An agent runs this unattended and has to
 * tell "you are not logged in" from "somebody else changed it" from "the server
 * is down" without reading English, so every failure is checked for its exit code
 * and its machine-readable name.
 */

let instance: TestInstance;
let workspace: string;
let output: string[];
let errors: string[];

beforeEach(async () => {
  instance = await startInstance();
  process.env.OPEN_ARTIFACT_HOME = instance.home;
  workspace = mkdtempSync(join(tmpdir(), 'open-artifact-files-'));
  output = [];
  errors = [];
});

afterEach(async () => {
  delete process.env.OPEN_ARTIFACT_HOME;
  rmSync(workspace, { recursive: true, force: true });
  await instance.stop();
});

function cli(...argv: string[]): Promise<number> {
  return run(argv, {
    print: (line) => output.push(line),
    printError: (line) => errors.push(line),
    sleep: async () => {},
  });
}

function printedJson(): Record<string, unknown> {
  const last = output.at(-1);
  if (!last) throw new Error(`nothing was printed. stderr: ${errors.join('\n')}`);
  return JSON.parse(last) as Record<string, unknown>;
}

function errorOf(): { code: string; message: string; hint?: string } {
  return printedJson().error as { code: string; message: string; hint?: string };
}

/** Writes a file into this test's workspace and returns its path. */
function writeArtifact(name: string, content: string): string {
  const path = join(workspace, name);
  writeFileSync(path, content);
  return path;
}

async function signIn(): Promise<void> {
  const sessionCookie = await instance.signIn('person@example.com');
  const running = cli('login', '--instance', instance.baseUrl, '--json');
  await instance.approveDeviceCode(await instance.waitForPendingCode(), sessionCookie);
  await running;
  output = [];
}

describe('publishing a file', () => {
  beforeEach(signIn);

  it('publishes Markdown and hands back a URL', async () => {
    const path = writeArtifact('report.md', '# Quarterly report\n\nRevenue is up.');

    expect(await cli('publish', path, '--json')).toBe(0);

    const result = printedJson();
    expect(result).toMatchObject({ ok: true, type: 'markdown', title: 'Quarterly report' });
    expect(String(result.url)).toContain('/a/');
    expect(String(result.id)).toMatch(/^art_/);
  });

  it('works out the type from the file extension, so nobody has to say', async () => {
    const markdown = writeArtifact('notes.md', '# Notes');
    const html = writeArtifact('dashboard.html', '<title>Dashboard</title><h1>Hi</h1>');

    await cli('publish', markdown, '--json');
    expect(printedJson().type).toBe('markdown');

    await cli('publish', html, '--json');
    expect(printedJson()).toMatchObject({ type: 'html', title: 'Dashboard' });
  });

  it('takes a title when one is given', async () => {
    const path = writeArtifact('report.md', '# Derived from this heading');
    await cli('publish', path, '--title', 'Chosen title', '--json');
    expect(printedJson().title).toBe('Chosen title');
  });

  it('prints the title and URL for a person when --json is not used', async () => {
    const path = writeArtifact('report.md', '# Quarterly report');
    expect(await cli('publish', path)).toBe(0);

    const printed = output.join('\n');
    expect(printed).toContain('Quarterly report');
    expect(printed).toContain('/a/');
  });

  it('publishes something the server can actually serve', async () => {
    const path = writeArtifact('report.md', '# Quarterly report\n\nRevenue is up.');
    await cli('publish', path, '--json');

    const page = await fetch(String(printedJson().url), {
      headers: { Cookie: await instance.signIn('person@example.com') },
    });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Quarterly report');
  });
});

describe('updating an artifact', () => {
  beforeEach(signIn);

  it('replaces the content and keeps the same URL', async () => {
    const path = writeArtifact('report.md', '# First draft');
    await cli('publish', path, '--json');
    const first = printedJson();

    writeFileSync(path, '# Second draft');
    output = [];
    expect(await cli('publish', path, '--id', String(first.id), '--json')).toBe(0);

    const second = printedJson();
    expect(second.url).toBe(first.url);
    expect(second.version).toBe(2);
    expect(second.updated).toBe(true);
  });

  it('sends the version it actually read, so it never guesses', async () => {
    // Two updates in a row must both succeed. They only can if the second one
    // read the new version rather than assuming version 1.
    const path = writeArtifact('report.md', '# One');
    await cli('publish', path, '--json');
    const id = String(printedJson().id);

    writeFileSync(path, '# Two');
    output = [];
    expect(await cli('publish', path, '--id', id, '--json')).toBe(0);

    writeFileSync(path, '# Three');
    output = [];
    expect(await cli('publish', path, '--id', id, '--json')).toBe(0);
    expect(printedJson().version).toBe(3);
  });

  it('says an artifact is not yours rather than pretending it is missing a file', async () => {
    const path = writeArtifact('report.md', '# Mine');
    expect(await cli('publish', path, '--id', 'art_belongs_to_nobody', '--json')).toBe(
      EXIT_CODES.noAccess,
    );
    expect(errorOf().code).toBe('noAccess');
  });
});

describe('when publishing goes wrong', () => {
  it('says you are not signed in, and how to fix it', async () => {
    const path = writeArtifact('report.md', '# Report');

    expect(await cli('publish', path, '--json')).toBe(EXIT_CODES.notAuthenticated);
    expect(errorOf().code).toBe('notAuthenticated');
    expect(errorOf().hint).toContain('open-artifact login');
  });

  it('refuses a file type it cannot render safely', async () => {
    await signIn();
    const path = writeArtifact('data.csv', 'a,b\n1,2');

    expect(await cli('publish', path, '--json')).toBe(EXIT_CODES.unsupportedType);
    expect(errorOf().code).toBe('unsupportedType');
    expect(errorOf().message).toContain('data.csv');
  });

  it('says which file is missing rather than failing obscurely', async () => {
    await signIn();

    expect(await cli('publish', join(workspace, 'nothing-here.md'), '--json')).toBe(
      EXIT_CODES.fileNotFound,
    );
    expect(errorOf().code).toBe('fileNotFound');
  });

  it('does not try to publish a directory', async () => {
    await signIn();
    mkdirSync(join(workspace, 'folder.md'));

    expect(await cli('publish', join(workspace, 'folder.md'), '--json')).toBe(
      EXIT_CODES.fileNotFound,
    );
  });

  it('says the file is too large, and what the limit is', async () => {
    const small = await startInstance({ MAX_ARTIFACT_BYTES: '2048' });
    process.env.OPEN_ARTIFACT_HOME = small.home;
    try {
      const sessionCookie = await small.signIn('person@example.com');
      const running = cli('login', '--instance', small.baseUrl, '--json');
      await small.approveDeviceCode(await small.waitForPendingCode(), sessionCookie);
      await running;
      output = [];

      const path = writeArtifact('big.md', 'x'.repeat(4000));
      expect(await cli('publish', path, '--json')).toBe(EXIT_CODES.tooLarge);
      expect(errorOf().code).toBe('tooLarge');
      expect(errorOf().message).toContain('2.0 KB');
    } finally {
      await small.stop();
    }
  });

  it('says the instance is unreachable rather than failing obscurely', async () => {
    await signIn();
    await instance.stopServer();

    const path = writeArtifact('report.md', '# Report');
    expect(await cli('publish', path, '--json')).toBe(EXIT_CODES.unreachable);
    expect(errorOf().code).toBe('unreachable');
  });

  it('asks which file when none was given', async () => {
    await signIn();
    expect(await cli('publish', '--json')).toBe(EXIT_CODES.usage);
    expect(errorOf().hint).toContain('publish report.md');
  });
});

describe('listing what you published', () => {
  beforeEach(signIn);

  it('lists artifacts newest first', async () => {
    await cli('publish', writeArtifact('one.md', '# First'), '--json');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await cli('publish', writeArtifact('two.md', '# Second'), '--json');
    output = [];

    expect(await cli('list', '--json')).toBe(0);
    const artifacts = printedJson().artifacts as { title: string }[];
    expect(artifacts.map((artifact) => artifact.title)).toEqual(['Second', 'First']);
  });

  it('says plainly when there is nothing yet', async () => {
    expect(await cli('list')).toBe(0);
    expect(output.join('\n')).toContain('not published anything yet');
  });
});

describe('deleting an artifact', () => {
  beforeEach(signIn);

  it('deletes when it is asked for explicitly', async () => {
    await cli('publish', writeArtifact('report.md', '# Bye'), '--json');
    const id = String(printedJson().id);
    output = [];

    expect(await cli('delete', id, '--confirm', '--json')).toBe(0);
    expect(printedJson()).toMatchObject({ ok: true, deleted: true, id });

    output = [];
    await cli('list', '--json');
    expect(printedJson().artifacts).toHaveLength(0);
  });

  it('refuses without --confirm, because a wrong id would be unrecoverable', async () => {
    await cli('publish', writeArtifact('report.md', '# Keep me'), '--json');
    const id = String(printedJson().id);
    output = [];

    expect(await cli('delete', id, '--json')).toBe(EXIT_CODES.usage);
    expect(errorOf().hint).toContain('--confirm');

    // And it is still there.
    output = [];
    await cli('list', '--json');
    expect(printedJson().artifacts).toHaveLength(1);
  });

  it('says an artifact is not yours rather than that it is gone', async () => {
    expect(await cli('delete', 'art_someone_elses', '--confirm', '--json')).toBe(
      EXIT_CODES.noAccess,
    );
    expect(errorOf().code).toBe('noAccess');
  });

  it('asks which artifact when none was given', async () => {
    expect(await cli('delete', '--json')).toBe(EXIT_CODES.usage);
  });
});

describe('the exit codes an agent branches on', () => {
  it('has a distinct code for every failure it can report', () => {
    // Two failures sharing a code means an agent cannot tell them apart, which
    // is the whole point of having them.
    const codes = Object.values(EXIT_CODES);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('uses zero only for success', () => {
    const failures = Object.entries(EXIT_CODES).filter(([name]) => name !== 'ok');
    for (const [, code] of failures) expect(code).toBeGreaterThan(0);
  });
});
