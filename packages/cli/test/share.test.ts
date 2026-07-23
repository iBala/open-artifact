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

beforeEach(async () => {
  instance = await startInstance();
  process.env.OPEN_ARTIFACT_HOME = instance.home;
  workspace = mkdtempSync(join(tmpdir(), 'open-artifact-share-'));
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

  writeFileSync(join(workspace, 'report.md'), '# Quarterly report');
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

describe('sharing from the command line', () => {
  it('starts private, and says so', async () => {
    expect(await cli('share', artifactId, 'show', '--json')).toBe(0);
    expect(printedJson()).toMatchObject({ ok: true, isPublic: false, people: [], domains: [] });
  });

  it('shares with a person', async () => {
    expect(await cli('share', artifactId, 'add', 'colleague@example.com', '--json')).toBe(0);
    expect(printedJson().people).toEqual([{ email: 'colleague@example.com', pending: true }]);
  });

  it('sends the person an email', async () => {
    await cli('share', artifactId, 'add', 'colleague@example.com', '--json');
    expect(instance.mailer.lastTo('colleague@example.com')?.subject).toContain('Quarterly report');
  });

  it('tells the difference between an address and a domain without being told', async () => {
    await cli('share', artifactId, 'add', 'colleague@example.com', '--json');
    await cli('share', artifactId, 'add', 'zorp.one', '--json');

    expect(printedJson()).toMatchObject({
      people: [{ email: 'colleague@example.com' }],
      domains: ['zorp.one'],
    });
  });

  it('stops sharing with a person', async () => {
    await cli('share', artifactId, 'add', 'colleague@example.com', '--json');
    output = [];

    expect(await cli('share', artifactId, 'remove', 'colleague@example.com', '--json')).toBe(0);
    expect(printedJson().people).toEqual([]);
  });

  it('stops sharing with a domain', async () => {
    await cli('share', artifactId, 'add', 'zorp.one', '--json');
    output = [];

    await cli('share', artifactId, 'remove', 'zorp.one', '--json');
    expect(printedJson().domains).toEqual([]);
  });

  it('makes an artifact public and private again', async () => {
    expect(await cli('share', artifactId, 'public', '--json')).toBe(0);
    expect(printedJson().isPublic).toBe(true);

    output = [];
    await cli('share', artifactId, 'private', '--json');
    expect(printedJson().isPublic).toBe(false);
  });

  it('refuses a public email provider as a domain, and says what to do instead', async () => {
    expect(await cli('share', artifactId, 'add', 'gmail.com', '--json')).toBe(EXIT_CODES.usage);
    const message = (printedJson().error as { message: string }).message;
    expect(message).toMatch(/individual addresses|public/i);
  });

  it('reports an artifact that is not yours as no access', async () => {
    expect(await cli('share', 'art_not_yours', 'show', '--json')).toBe(EXIT_CODES.noAccess);
  });

  it('asks who, when add is given nothing to add', async () => {
    expect(await cli('share', artifactId, 'add', '--json')).toBe(EXIT_CODES.usage);
    expect((printedJson().error as { hint: string }).hint).toContain('colleague@example.com');
  });

  it('refuses a subcommand it does not have', async () => {
    expect(await cli('share', artifactId, 'unshare-everything', '--json')).toBe(EXIT_CODES.usage);
    expect((printedJson().error as { hint: string }).hint).toContain('show, add, remove');
  });

  it('defaults to showing when no subcommand is given', async () => {
    expect(await cli('share', artifactId, '--json')).toBe(0);
    expect(printedJson()).toHaveProperty('isPublic');
  });
});

describe('what the person reading the output sees', () => {
  it('says plainly that nobody else can see it', async () => {
    await cli('share', artifactId, 'show');
    expect(output.join('\n')).toContain('Nobody else can see it');
  });

  it('marks somebody who has not signed in yet', async () => {
    await cli('share', artifactId, 'add', 'colleague@example.com', '--json');
    output = [];

    await cli('share', artifactId, 'show');
    expect(output.join('\n')).toContain('has not signed in yet');
  });

  it('says what public actually means', async () => {
    await cli('share', artifactId, 'public');
    expect(output.join('\n')).toContain('anybody with the link');
  });
});

describe('sharing actually grants access', () => {
  it('lets the person open the artifact once they sign in', async () => {
    await cli('share', artifactId, 'add', 'colleague@example.com', '--json');

    const colleagueCookie = await instance.signIn('colleague@example.com');
    const response = await fetch(`${instance.baseUrl}/api/artifacts/${artifactId}`, {
      headers: { Cookie: colleagueCookie },
    });
    expect(response.status).toBe(200);
  });

  it('and removing it takes that access away', async () => {
    await cli('share', artifactId, 'add', 'colleague@example.com', '--json');
    const colleagueCookie = await instance.signIn('colleague@example.com');
    await cli('share', artifactId, 'remove', 'colleague@example.com', '--json');

    const response = await fetch(`${instance.baseUrl}/api/artifacts/${artifactId}`, {
      headers: { Cookie: colleagueCookie },
    });
    expect(response.status).toBe(404);
  });
});
