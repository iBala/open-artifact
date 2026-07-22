import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { statSync, existsSync, readFileSync } from 'node:fs';
import { run } from '../src/run.js';
import { credentialsPath, loadCredential } from '../src/credentials.js';
import { startInstance, type TestInstance } from './helpers/instance.js';

/**
 * The command line, end to end, against a real server.
 *
 * Nothing about the network or the token is stubbed. The only thing these tests
 * fake is the passing of time: signing in polls every two seconds, and a test
 * suite should not.
 */

let instance: TestInstance;
let output: string[];
let errors: string[];

beforeEach(async () => {
  instance = await startInstance();
  // Every test gets its own credentials directory. A real home is never touched.
  process.env.OPEN_ARTIFACT_HOME = instance.home;
  output = [];
  errors = [];
});

afterEach(async () => {
  delete process.env.OPEN_ARTIFACT_HOME;
  await instance.stop();
});

/** Runs a command with output captured and no real waiting. */
function cli(...argv: string[]): Promise<number> {
  return run(argv, {
    print: (line) => output.push(line),
    printError: (line) => errors.push(line),
    sleep: async () => {},
  });
}

/** The JSON object a `--json` run printed. */
function printedJson(): Record<string, unknown> {
  const last = output.at(-1);
  if (!last) throw new Error(`nothing was printed. stderr: ${errors.join('\n')}`);
  return JSON.parse(last) as Record<string, unknown>;
}

/**
 * Signs the CLI in.
 *
 * Login polls until somebody approves, so the approval has to happen while the
 * command is still running: start it, wait for the code to appear on the server,
 * approve it, then let the command finish. This is exactly the shape of the real
 * thing, with a person at the browser.
 */
async function signInThroughTheCli(
  email = 'person@example.com',
  extraArgs: string[] = ['--json'],
): Promise<number> {
  const sessionCookie = await instance.signIn(email);
  const running = cli('login', '--instance', instance.baseUrl, ...extraArgs);

  const code = await instance.waitForPendingCode();
  await instance.approveDeviceCode(code, sessionCookie);

  return running;
}

describe('signing in from the command line', () => {
  it('signs in once the person approves in their browser', async () => {
    expect(await signInThroughTheCli()).toBe(0);

    expect(printedJson()).toMatchObject({
      ok: true,
      signedIn: true,
      email: 'person@example.com',
      instance: instance.baseUrl,
    });
  });

  it('prints the code and the URL for the person to open', async () => {
    // Without --json, the output is written for a person to act on.
    expect(await signInThroughTheCli('person@example.com', [])).toBe(0);

    const printed = output.join('\n');
    expect(printed).toMatch(/[A-Z0-9]{4}-[A-Z0-9]{4}/);
    expect(printed).toContain('/auth/device?code=');
    expect(printed).toContain('person@example.com');
  });

  it('stores the token where later commands find it', async () => {
    await signInThroughTheCli();

    const credential = loadCredential();
    expect(credential?.baseUrl).toBe(instance.baseUrl);
    expect(credential?.email).toBe('person@example.com');
    expect(credential?.token.length).toBeGreaterThan(30);
  });

  it('writes the credentials file so only its owner can read it', async () => {
    await signInThroughTheCli();

    // On a shared machine this file is the account.
    expect((statSync(credentialsPath()).mode & 0o777).toString(8)).toBe('600');
  });

  it('gives the token an expiry about ninety days out', async () => {
    await signInThroughTheCli();

    const expiresAt = loadCredential()?.expiresAt ?? '';
    const days = (new Date(expiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(89);
  });

  it('gives up with a clear reason when the person refuses', async () => {
    const sessionCookie = await instance.signIn('person@example.com');
    const running = cli('login', '--instance', instance.baseUrl, '--json');

    const code = await instance.waitForPendingCode();
    await fetch(`${instance.baseUrl}/api/auth/device/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
      body: JSON.stringify({ userCode: code, approve: false }),
    });

    expect(await running).toBe(3);
    expect((printedJson().error as { code: string }).code).toBe('notAuthenticated');
    // Nothing was written, because nothing was granted.
    expect(existsSync(credentialsPath())).toBe(false);
  });

  it('says the instance is unreachable rather than failing obscurely', async () => {
    expect(await cli('login', '--instance', 'http://127.0.0.1:1', '--json')).toBe(8);

    const error = printedJson().error as { code: string; message: string };
    expect(error.code).toBe('unreachable');
    expect(error.message).toContain('127.0.0.1:1');
  });

  it('refuses to guess an instance when none has ever been used', async () => {
    expect(await cli('login', '--json')).toBe(2);
    expect((printedJson().error as { code: string }).code).toBe('usage');
  });
});

describe('whoami', () => {
  it('says who this machine is signed in as', async () => {
    await signInThroughTheCli();
    output = [];

    expect(await cli('whoami', '--json')).toBe(0);
    expect(printedJson()).toMatchObject({
      ok: true,
      email: 'person@example.com',
      instance: instance.baseUrl,
    });
  });

  it('says plainly when nobody is signed in, and how to fix it', async () => {
    expect(await cli('whoami', '--json')).toBe(3);

    const error = printedJson().error as { code: string; hint: string };
    expect(error.code).toBe('notAuthenticated');
    expect(error.hint).toContain('open-artifact login');
  });

  it('stops working the moment the token is revoked from the sessions page', async () => {
    await signInThroughTheCli();
    const sessionCookie = await instance.signIn('person@example.com');

    const listed = (await (
      await fetch(`${instance.baseUrl}/api/auth/sessions`, { headers: { Cookie: sessionCookie } })
    ).json()) as { tokens: { id: string }[] };

    await fetch(`${instance.baseUrl}/api/auth/tokens/${listed.tokens[0]?.id}`, {
      method: 'DELETE',
      headers: { Cookie: sessionCookie },
    });

    output = [];
    expect(await cli('whoami', '--json')).toBe(3);
  });
});

describe('signing out', () => {
  it('revokes the token on the server and removes it from this machine', async () => {
    await signInThroughTheCli();
    const token = loadCredential()?.token ?? '';
    output = [];

    expect(await cli('logout', '--json')).toBe(0);
    expect(printedJson()).toMatchObject({ ok: true, signedOut: true, revokedOnServer: true });

    // Gone from disk.
    expect(loadCredential()).toBeNull();

    // And dead on the server, not merely forgotten here.
    const response = await fetch(`${instance.baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(401);
  });

  it('is not an error when nobody was signed in', async () => {
    expect(await cli('logout', '--json')).toBe(0);
    expect(printedJson()).toMatchObject({ ok: true, signedOut: false });
  });

  it('still removes the local token when the server cannot be reached', async () => {
    await signInThroughTheCli();
    // The instance goes away, but this machine's credentials file stays put.
    await instance.stopServer();
    output = [];

    // A token left on disk that somebody believes is gone is the worse failure,
    // so the local copy goes either way and the command says what happened.
    expect(await cli('logout', '--json')).toBe(0);
    expect(printedJson()).toMatchObject({ signedOut: true, revokedOnServer: false });
    expect(loadCredential()).toBeNull();
  });
});

describe('being signed in to more than one instance', () => {
  it('keeps an entry per instance and uses the one signed into most recently', async () => {
    await signInThroughTheCli();

    const second = await startInstance();
    try {
      const sessionCookie = await second.signIn('person@example.com');
      const running = cli('login', '--instance', second.baseUrl, '--json');
      await second.approveDeviceCode(await second.waitForPendingCode(), sessionCookie);
      expect(await running).toBe(0);

      const file = JSON.parse(readFileSync(credentialsPath(), 'utf8')) as {
        instances: Record<string, unknown>;
        defaultInstance: string;
      };
      expect(Object.keys(file.instances)).toHaveLength(2);
      expect(file.defaultInstance).toBe(second.baseUrl);
    } finally {
      await second.stop();
    }
  });

  it('signing out of one leaves the other signed in', async () => {
    await signInThroughTheCli();
    const first = instance.baseUrl;

    const second = await startInstance();
    try {
      const sessionCookie = await second.signIn('person@example.com');
      const running = cli('login', '--instance', second.baseUrl, '--json');
      await second.approveDeviceCode(await second.waitForPendingCode(), sessionCookie);
      await running;

      await cli('logout', '--instance', second.baseUrl, '--json');

      expect(loadCredential(second.baseUrl)).toBeNull();
      expect(loadCredential(first)?.baseUrl).toBe(first);
    } finally {
      await second.stop();
    }
  });
});

describe('the shape of the output', () => {
  it('prints exactly one JSON object with --json, even when it fails', async () => {
    await cli('whoami', '--json');

    expect(output).toHaveLength(1);
    expect(() => JSON.parse(output[0] ?? '')).not.toThrow();
    // Nothing else on stdout: an agent reads this and nothing else.
    expect(errors).toHaveLength(0);
  });

  it('writes failures to stderr and nothing to stdout without --json', async () => {
    expect(await cli('whoami')).toBe(3);

    expect(output).toHaveLength(0);
    expect(errors.join('\n')).toContain('not signed in');
    expect(errors.join('\n')).toContain('open-artifact login');
  });

  it('refuses a command it does not have, and points at help', async () => {
    expect(await cli('publsh', '--json')).toBe(2);
    expect((printedJson().error as { hint: string }).hint).toContain('help');
  });

  it('prints help when asked', async () => {
    expect(await cli('help')).toBe(0);
    expect(output.join('\n')).toContain('open-artifact');
  });
});
