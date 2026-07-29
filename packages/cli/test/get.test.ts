import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/run.js';
import { EXIT_CODES } from '../src/errors.js';
import { startInstance, type TestInstance } from './helpers/instance.js';

/**
 * Reading an artifact back.
 *
 * An agent publishes in one session and comes back in another, with the local
 * file long gone. Without a read command the only way back to its own words is
 * the web page, which is private and needs a browser — so it would rewrite from
 * memory and quietly lose whatever it had changed. These tests hold the round
 * trip: publish, read it back, edit, publish again.
 */

let instance: TestInstance;
let workspace: string;
let output: string[];
let errors: string[];

beforeEach(async () => {
  instance = await startInstance();
  process.env.OPEN_ARTIFACT_HOME = instance.home;
  workspace = mkdtempSync(join(tmpdir(), 'open-artifact-get-'));
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

async function signIn(email = 'person@example.com'): Promise<void> {
  await cli('login', '--instance', instance.baseUrl, '--email', email, '--json');
  await cli(
    'login',
    '--instance',
    instance.baseUrl,
    '--email',
    email,
    '--code',
    instance.emailedCodeFor(email),
    '--json',
  );
  output = [];
}

/** Publishes a file and returns the new artifact's id. */
async function publish(name: string, content: string): Promise<string> {
  const path = join(workspace, name);
  writeFileSync(path, content);
  await cli('publish', path, '--json');
  const id = printedJson().id as string;
  output = [];
  return id;
}

describe('reading an artifact back', () => {
  beforeEach(() => signIn());

  it('hands back the content it published, with the version to update from', async () => {
    const id = await publish('report.md', '# Quarterly report\n\nRevenue is up 12%.\n');

    const code = await cli('get', id, '--json');

    expect(code).toBe(0);
    const result = printedJson();
    expect(result.ok).toBe(true);
    expect(result.id).toBe(id);
    expect(result.content).toBe('# Quarterly report\n\nRevenue is up 12%.\n');
    expect(result.type).toBe('markdown');
    expect(result.title).toBe('Quarterly report');
    expect(result.version).toBe(1);
    expect(result.url).toContain('/a/');
  });

  it('reads back the current version after an update, not the first one', async () => {
    const path = join(workspace, 'report.md');
    writeFileSync(path, '# Report\n\nFirst.\n');
    await cli('publish', path, '--json');
    const id = printedJson().id as string;

    writeFileSync(path, '# Report\n\nSecond.\n');
    await cli('publish', path, '--id', id, '--json');
    output = [];

    await cli('get', id, '--json');

    const result = printedJson();
    expect(result.content).toBe('# Report\n\nSecond.\n');
    expect(result.version).toBe(2);
  });

  it('writes the content to a file with --out, and leaves it out of the JSON', async () => {
    const id = await publish('page.html', '<h1>Dashboard</h1>\n');
    const destination = join(workspace, 'fetched.html');

    const code = await cli('get', id, '--out', destination, '--json');

    expect(code).toBe(0);
    expect(readFileSync(destination, 'utf8')).toBe('<h1>Dashboard</h1>\n');
    const result = printedJson();
    expect(result.file).toBe(destination);
    expect(result.content).toBeUndefined();
    expect(result.version).toBe(1);
  });

  it('closes the loop: read it back, change it, publish it again', async () => {
    const id = await publish('report.md', '# Report\n\nRevenue is up 12%.\n');
    const scratch = join(workspace, 'round-trip.md');

    await cli('get', id, '--out', scratch, '--json');
    writeFileSync(scratch, `${readFileSync(scratch, 'utf8')}\nSource: the ledger.\n`);
    output = [];

    const code = await cli('publish', scratch, '--id', id, '--json');

    expect(code).toBe(0);
    expect(printedJson().version).toBe(2);
    output = [];

    await cli('get', id, '--json');
    expect(printedJson().content).toContain('Source: the ledger.');
  });

  it('prints only the content when no one asked for JSON, so it can be redirected', async () => {
    const id = await publish('report.md', '# Report\n\nRevenue is up 12%.\n');

    const code = await cli('get', id);

    expect(code).toBe(0);
    // What a redirect would capture: every printed line, each with its newline.
    expect(output.map((line) => `${line}\n`).join('')).toBe('# Report\n\nRevenue is up 12%.\n');
  });

  it('takes the link as well as the id, because a link is what gets kept', async () => {
    const id = await publish('report.md', '# Report\n\nRevenue is up 12%.\n');
    await cli('get', id, '--json');
    const url = printedJson().url as string;
    output = [];

    const code = await cli('get', url, '--json');

    expect(code).toBe(0);
    expect(printedJson().id).toBe(id);
    expect(printedJson().content).toBe('# Report\n\nRevenue is up 12%.\n');
  });

  it('says which artifact when none was named', async () => {
    const code = await cli('get', '--json');

    expect(code).toBe(EXIT_CODES.usage);
    expect(errorOf().code).toBe('usage');
  });

  it('refuses an artifact that is not yours, the same as every other command', async () => {
    const id = await publish('report.md', '# Mine\n');

    await cli('logout', '--json');
    await signIn('somebody-else@example.com');

    const code = await cli('get', id, '--json');

    expect(code).toBe(EXIT_CODES.noAccess);
    expect(errorOf().code).toBe('noAccess');
  });

  it('reports a bad id as no access rather than a server failure', async () => {
    const code = await cli('get', 'art_doesNotExist', '--json');

    expect(code).toBe(EXIT_CODES.noAccess);
    expect(errorOf().code).toBe('noAccess');
  });
});

describe('reading while signed out', () => {
  it('asks for a sign-in rather than failing obscurely', async () => {
    const code = await cli('get', 'art_anything', '--instance', instance.baseUrl, '--json');

    expect(code).toBe(EXIT_CODES.notAuthenticated);
    expect(errorOf().code).toBe('notAuthenticated');
  });
});
