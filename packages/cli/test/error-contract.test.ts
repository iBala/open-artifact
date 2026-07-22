import { describe, it, expect } from 'vitest';
import { ApiClient } from '../src/api.js';
import { CliError, EXIT_CODES } from '../src/errors.js';

/**
 * How the server's errors become the CLI's errors.
 *
 * This is the contract an agent depends on. It is tested against fabricated
 * responses rather than a live server, because some of these are hard to
 * provoke on purpose and all of them have to be covered.
 */

/** A client whose server always answers with the given status and body. */
function clientReturning(status: number, body: unknown): ApiClient {
  return new ApiClient({
    baseUrl: 'https://artifacts.test',
    token: 'a-token',
    fetchImpl: async () =>
      new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
  });
}

async function failureFrom(status: number, body: unknown): Promise<CliError> {
  try {
    await clientReturning(status, body).request('/api/artifacts');
  } catch (error) {
    if (error instanceof CliError) return error;
    throw error;
  }
  throw new Error('expected the request to fail');
}

const cases: {
  what: string;
  status: number;
  code: string;
  expected: keyof typeof EXIT_CODES;
}[] = [
  { what: 'no credentials', status: 401, code: 'unauthenticated', expected: 'notAuthenticated' },
  { what: 'not yours or missing', status: 404, code: 'not_found', expected: 'noAccess' },
  { what: 'refused', status: 403, code: 'forbidden', expected: 'noAccess' },
  { what: 'wrong file type', status: 400, code: 'unsupported_type', expected: 'unsupportedType' },
  { what: 'the server refused what was sent', status: 400, code: 'validation_failed', expected: 'usage' },
  { what: 'too large', status: 413, code: 'payload_too_large', expected: 'tooLarge' },
  { what: 'someone got there first', status: 409, code: 'version_conflict', expected: 'conflict' },
  { what: 'something else broke', status: 500, code: 'internal_error', expected: 'serverError' },
];

describe('turning a server error into an exit code', () => {
  for (const testCase of cases) {
    it(`reports ${testCase.what} as ${testCase.expected}`, async () => {
      const failure = await failureFrom(testCase.status, {
        error: { code: testCase.code, message: 'something happened' },
      });

      expect(failure.name_).toBe(testCase.expected);
      expect(failure.exitCode).toBe(EXIT_CODES[testCase.expected]);
    });
  }

  it('tells an agent what to do about a version conflict', async () => {
    const failure = await failureFrom(409, {
      error: {
        code: 'version_conflict',
        message: 'This artifact has changed since you last read it.',
        details: { currentVersion: 4, baseVersion: 2 },
      },
    });

    expect(failure.hint).toContain('Read the artifact again');
    // The versions come through, so an agent can decide what to do without
    // parsing the message.
    expect(failure.details).toMatchObject({ currentVersion: 4, baseVersion: 2 });
  });

  it('falls back to what the status means when the body has no code', async () => {
    // A proxy in front of the instance might return HTML, or nothing useful.
    expect((await failureFrom(401, undefined)).name_).toBe('notAuthenticated');
    expect((await failureFrom(404, undefined)).name_).toBe('noAccess');
    expect((await failureFrom(502, undefined)).name_).toBe('serverError');
  });

  it('reports a server it cannot reach at all as unreachable, not as a server error', async () => {
    const client = new ApiClient({
      baseUrl: 'https://artifacts.test',
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    });

    try {
      await client.request('/api/artifacts');
      throw new Error('expected the request to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).name_).toBe('unreachable');
      // "Is the server down or am I logged out" is the first question anybody
      // asks, so these must never be the same answer.
      expect((error as CliError).exitCode).not.toBe(EXIT_CODES.notAuthenticated);
    }
  });
});

describe('the shape of a reported failure', () => {
  it('is the same for every failure, so an agent parses it once', async () => {
    const failure = await failureFrom(413, {
      error: { code: 'payload_too_large', message: 'Too big.' },
    });

    expect(failure.toJson()).toMatchObject({
      ok: false,
      error: { code: 'tooLarge', message: 'Too big.' },
    });
  });
});
