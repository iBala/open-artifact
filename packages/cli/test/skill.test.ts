import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../src/run.js';
import { EXIT_CODES } from '../src/errors.js';
import { startInstance, type TestInstance } from './helpers/instance.js';

/**
 * The skill, checked against what actually happens.
 *
 * SKILL.md tells an agent which commands to run, what the JSON looks like, and
 * what each exit code means. An agent will follow it literally, so every claim in
 * it has to be true. This runs the documented commands and checks the documented
 * claims, which is what stops the instructions drifting away from the software
 * they describe.
 */

const SKILL = readFileSync(
  fileURLToPath(new URL('../../../skill/SKILL.md', import.meta.url)),
  'utf8',
);

let instance: TestInstance;
let workspace: string;
let output: string[];

beforeEach(async () => {
  instance = await startInstance();
  process.env.OPEN_ARTIFACT_HOME = instance.home;
  workspace = mkdtempSync(join(tmpdir(), 'open-artifact-skill-'));
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

function lastJson(): Record<string, unknown> {
  return JSON.parse(output.at(-1) ?? '{}') as Record<string, unknown>;
}

async function signIn(): Promise<void> {
  const sessionCookie = await instance.signIn('agent@example.com');
  const running = cli('login', '--instance', instance.baseUrl, '--json');
  await instance.approveDeviceCode(await instance.waitForPendingCode(), sessionCookie);
  await running;
  output = [];
}

/**
 * The whole documented sequence, in order, exactly as SKILL.md describes it.
 * This is the gate: if an agent follows the instructions, this is what happens.
 */
describe('following SKILL.md end to end', () => {
  it('checks who it is, signs in, publishes, updates, lists and deletes', async () => {
    // 1. "Before anything else": exit 3 means sign in.
    expect(await cli('whoami', '--json')).toBe(3);
    expect((lastJson().error as { code: string }).code).toBe('notAuthenticated');

    // 2. Signing in.
    await signIn();
    expect(await cli('whoami', '--json')).toBe(0);
    expect(lastJson()).toMatchObject({ ok: true, email: 'agent@example.com' });

    // 3. Publishing.
    const path = join(workspace, 'report.md');
    writeFileSync(path, '# Quarterly report\n\nRevenue is up.');
    output = [];
    expect(await cli('publish', path, '--json')).toBe(0);

    const published = lastJson();
    // Every field the skill tells an agent to read.
    expect(published).toMatchObject({
      ok: true,
      title: 'Quarterly report',
      type: 'markdown',
      version: 1,
      updated: false,
    });
    expect(String(published.id)).toMatch(/^art_/);
    expect(String(published.url)).toMatch(/^https?:\/\/.+\/a\/.+/);

    // The URL an agent is told to hand over must actually work.
    const sessionCookie = await instance.signIn('agent@example.com');
    const page = await fetch(String(published.url), { headers: { Cookie: sessionCookie } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Quarterly report');

    // 4. Updating keeps the same URL.
    writeFileSync(path, '# Quarterly report\n\nRevenue is up, and here is why.');
    output = [];
    expect(await cli('publish', path, '--id', String(published.id), '--json')).toBe(0);
    expect(lastJson()).toMatchObject({ url: published.url, version: 2, updated: true });

    // 5. Listing.
    output = [];
    expect(await cli('list', '--json')).toBe(0);
    expect(lastJson().artifacts).toHaveLength(1);

    // 6. Deleting, which needs --confirm.
    output = [];
    expect(await cli('delete', String(published.id), '--json')).toBe(EXIT_CODES.usage);

    output = [];
    expect(await cli('delete', String(published.id), '--confirm', '--json')).toBe(0);
    expect(lastJson()).toMatchObject({ ok: true, deleted: true });

    output = [];
    await cli('list', '--json');
    expect(lastJson().artifacts).toHaveLength(0);
  });
});

describe('every exit code the skill documents', () => {
  /** The table in SKILL.md, read out of the file rather than copied here. */
  function documentedCodes(): Map<number, string> {
    const codes = new Map<number, string>();
    for (const line of SKILL.split('\n')) {
      const row = /^\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|/.exec(line);
      if (row?.[1] && row[2]) codes.set(Number(row[1]), row[2]);
    }
    return codes;
  }

  it('is a code the CLI can actually return', () => {
    const real = new Set<number>(Object.values(EXIT_CODES));
    for (const code of documentedCodes().keys()) {
      expect(real.has(code), `SKILL.md documents exit code ${code}, which the CLI never returns`).toBe(
        true,
      );
    }
  });

  it('covers every code the CLI can return', () => {
    const documented = documentedCodes();
    for (const [name, code] of Object.entries(EXIT_CODES)) {
      expect(
        documented.has(code),
        `the CLI can exit ${code} (${name}) but SKILL.md does not say what that means`,
      ).toBe(true);
    }
  });

  it('means what it says, for the ones an agent branches on', async () => {
    await signIn();

    // 5: not Markdown or HTML.
    writeFileSync(join(workspace, 'data.csv'), 'a,b');
    expect(await cli('publish', join(workspace, 'data.csv'), '--json')).toBe(5);

    // 10: no such file.
    expect(await cli('publish', join(workspace, 'missing.md'), '--json')).toBe(10);

    // 4: not yours, or no such artifact.
    expect(await cli('delete', 'art_not_yours', '--confirm', '--json')).toBe(4);

    // 2: the command was wrong.
    expect(await cli('publish', '--json')).toBe(2);

    // 8: the server cannot be reached.
    await instance.stopServer();
    writeFileSync(join(workspace, 'fine.md'), '# Fine');
    expect(await cli('publish', join(workspace, 'fine.md'), '--json')).toBe(8);
  });
});

describe('what SKILL.md promises about the JSON', () => {
  it('is one object and nothing else, on success', async () => {
    await signIn();
    writeFileSync(join(workspace, 'report.md'), '# Report');

    output = [];
    await cli('publish', join(workspace, 'report.md'), '--json');

    expect(output).toHaveLength(1);
    expect(lastJson().ok).toBe(true);
  });

  it('is one object and nothing else, on failure', async () => {
    output = [];
    await cli('whoami', '--json');

    expect(output).toHaveLength(1);
    expect(lastJson().ok).toBe(false);
    expect(lastJson()).toHaveProperty('error');
  });
});

describe('what SKILL.md says about file types', () => {
  it('publishes every extension it lists, and refuses the rest', async () => {
    await signIn();

    for (const [name, expectedType, content] of [
      ['a.md', 'markdown', '# Hi'],
      ['b.markdown', 'markdown', '# Hi'],
      ['c.html', 'html', '<h1>Hi</h1>'],
      ['d.htm', 'html', '<h1>Hi</h1>'],
    ] as const) {
      writeFileSync(join(workspace, name), content);
      output = [];
      expect(await cli('publish', join(workspace, name), '--json'), name).toBe(0);
      expect(lastJson().type, name).toBe(expectedType);
    }

    writeFileSync(join(workspace, 'e.txt'), 'plain');
    expect(await cli('publish', join(workspace, 'e.txt'), '--json')).toBe(5);
  });
});

describe('what SKILL.md says an HTML artifact cannot do', () => {
  it('is what the served page actually enforces', async () => {
    await signIn();
    writeFileSync(join(workspace, 'dashboard.html'), '<h1>Dashboard</h1>');

    output = [];
    await cli('publish', join(workspace, 'dashboard.html'), '--json');
    const url = new URL(String(lastJson().url));

    const sessionCookie = await instance.signIn('agent@example.com');
    const content = await fetch(`${url.origin}${url.pathname}/content`, {
      headers: { Cookie: sessionCookie },
    });
    const policy = content.headers.get('content-security-policy') ?? '';

    // "cannot make network requests of any kind"
    expect(policy).toContain("connect-src 'none'");
    // "cannot load anything from another site"
    expect(policy).toContain("default-src 'none'");
    expect(policy).not.toMatch(/script-src[^;]*https:/);
    // "cannot reach the reader's session"
    expect(policy).toContain('sandbox allow-scripts');
    // "its own inline script and styles work"
    expect(policy).toContain("script-src 'unsafe-inline'");
  });
});

describe('the commands SKILL.md tells an agent to run', () => {
  it('all exist', async () => {
    // Pulled out of the fenced bash blocks, so adding an example to the skill
    // without adding the command is caught here.
    const commands = new Set<string>();
    for (const block of SKILL.matchAll(/```bash\n([\s\S]*?)```/g)) {
      for (const line of (block[1] ?? '').split('\n')) {
        const match = /^open-artifact\s+([a-z-]+)/.exec(line.trim());
        if (match?.[1]) commands.add(match[1]);
      }
    }

    expect(commands.size).toBeGreaterThan(4);
    for (const command of commands) {
      // An unknown command exits 2 with a usage error; a real one does not.
      output = [];
      const exitCode = await cli(command, '--json');
      expect(
        (lastJson().error as { message?: string } | undefined)?.message ?? '',
        `SKILL.md tells an agent to run "${command}"`,
      ).not.toContain('There is no');
      void exitCode;
    }
  });
});
