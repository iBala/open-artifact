import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkForUpdate, isNewer, updateNotice } from '../src/version-check.js';
import { run } from '../src/run.js';

/**
 * Telling the user a newer version is out.
 *
 * The suite as a whole switches the check off so no other test touches the
 * network. Here we switch it back on and hand it a fetch we control, so we can
 * see it notice a new version, stay quiet when there is none, cache its answer,
 * and never break the command it runs alongside.
 */

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'open-artifact-version-'));
  process.env.OPEN_ARTIFACT_HOME = home;
  // The suite disables the check; this file is where we exercise it.
  delete process.env.OPEN_ARTIFACT_NO_UPDATE_CHECK;
  delete process.env.NO_UPDATE_NOTIFIER;
  delete process.env.CI;
});

afterEach(() => {
  delete process.env.OPEN_ARTIFACT_HOME;
  process.env.OPEN_ARTIFACT_NO_UPDATE_CHECK = '1';
  rmSync(home, { recursive: true, force: true });
});

/** A fetch that answers the npm "latest" request with a version we choose. */
function npmReturning(version: string, calls?: { count: number }): typeof fetch {
  return (async () => {
    if (calls) calls.count += 1;
    return new Response(JSON.stringify({ version }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

describe('comparing versions', () => {
  it('sees a real bump as newer', () => {
    expect(isNewer('0.3.0', '0.2.0')).toBe(true);
    expect(isNewer('1.0.0', '0.9.9')).toBe(true);
    expect(isNewer('0.2.1', '0.2.0')).toBe(true);
  });

  it('does not nag when equal or behind', () => {
    expect(isNewer('0.2.0', '0.2.0')).toBe(false);
    expect(isNewer('0.1.0', '0.2.0')).toBe(false);
  });

  it('never suggests a pre-release to a stable user', () => {
    expect(isNewer('0.3.0-beta.1', '0.2.0')).toBe(false);
  });

  it('treats nonsense as not newer rather than throwing', () => {
    expect(isNewer('not-a-version', '0.2.0')).toBe(false);
  });
});

describe('checking for an update', () => {
  it('reports the newer version and the exact upgrade command', async () => {
    const update = await checkForUpdate({
      current: '0.2.0',
      fetchImpl: npmReturning('0.5.0'),
      now: () => 1000,
    });

    expect(update?.latest).toBe('0.5.0');
    expect(update?.current).toBe('0.2.0');
    expect(update?.upgradeCommand).toContain('open-artifact@latest');
    expect(update?.upgradeCommand).toContain('registry.npmjs.org');
  });

  it('says nothing when already on the latest', async () => {
    const update = await checkForUpdate({
      current: '0.5.0',
      fetchImpl: npmReturning('0.5.0'),
      now: () => 1000,
    });
    expect(update).toBeNull();
  });

  it('checks the network once, then serves from cache within the day', async () => {
    const calls = { count: 0 };
    const fetchImpl = npmReturning('0.5.0', calls);

    await checkForUpdate({ current: '0.2.0', fetchImpl, now: () => 1000 });
    await checkForUpdate({ current: '0.2.0', fetchImpl, now: () => 1000 + 60_000 });

    expect(calls.count).toBe(1);
  });

  it('never fails the caller when npm is unreachable', async () => {
    const brokenFetch = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    await expect(
      checkForUpdate({ current: '0.2.0', fetchImpl: brokenFetch, now: () => 1000 }),
    ).resolves.toBeNull();
  });

  it('stays silent when switched off', async () => {
    process.env.OPEN_ARTIFACT_NO_UPDATE_CHECK = '1';
    const update = await checkForUpdate({
      current: '0.2.0',
      fetchImpl: npmReturning('9.9.9'),
      now: () => 1000,
    });
    expect(update).toBeNull();
  });

  it('writes a one-line notice a person can act on', () => {
    const notice = updateNotice({
      current: '0.2.0',
      latest: '0.5.0',
      upgradeCommand: 'npm install -g open-artifact@latest --registry https://registry.npmjs.org/',
    });
    expect(notice).toContain('0.5.0');
    expect(notice).toContain('0.2.0');
    expect(notice).toContain('npm install -g open-artifact@latest');
  });
});

describe('the notice on a real command', () => {
  it('rides along in the JSON so an agent can pass it on', async () => {
    const output: string[] = [];
    const exit = await run(['version', '--json'], {
      fetchImpl: npmReturning('9.9.9'),
      print: (line) => output.push(line),
      printError: () => undefined,
    });

    expect(exit).toBe(0);
    const printed = JSON.parse(output.at(-1) ?? '{}') as Record<string, unknown>;
    expect(printed.updateAvailable).toBe(true);
    expect(printed.latestVersion).toBe('9.9.9');
    expect(printed.upgradeCommand).toContain('open-artifact@latest');
  });

  it('goes to stderr for a person, never onto stdout', async () => {
    const output: string[] = [];
    const errors: string[] = [];
    await run(['version'], {
      fetchImpl: npmReturning('9.9.9'),
      print: (line) => output.push(line),
      printError: (line) => errors.push(line),
    });

    // stdout still carries only the version the command prints.
    expect(output.join('\n')).not.toContain('newer');
    expect(errors.join('\n')).toContain('9.9.9');
  });
});
