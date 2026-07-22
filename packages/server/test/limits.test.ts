import { describe, it, expect, afterEach } from 'vitest';
import { createTestServer, signIn, jsonBody, type TestServer } from './helpers/server.js';

/**
 * Limits and caps.
 *
 * These exist for three things, in order of how likely each is: an agent stuck
 * in a loop filling a disk, somebody guessing sign-in codes across many
 * addresses, and somebody using an open instance as a mail relay. Each is
 * checked here against the thing it is for, not just against the number.
 */

const servers: TestServer[] = [];

afterEach(() => {
  while (servers.length > 0) servers.pop()?.close();
});

function serverWith(env: Record<string, string | undefined>): TestServer {
  const server = createTestServer({ SIGNUP_MODE: 'open', ...env });
  servers.push(server);
  return server;
}

describe('an agent stuck in a loop', () => {
  it('is stopped after the publishes it is allowed, and told when to try again', async () => {
    const server = serverWith({ MAX_PUBLISHES_PER_HOUR: '3' });
    const agent = await signIn(server, 'agent@example.com');

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await agent.as('/api/artifacts', jsonBody({ type: 'markdown', content: `# ${attempt}` }));
      expect(response.status).toBe(201);
    }

    const stopped = await agent.as('/api/artifacts', jsonBody({ type: 'markdown', content: '# Again' }));
    expect(stopped.status).toBe(429);

    const body = (await stopped.json()) as { error: { code: string; details: Record<string, number> } };
    expect(body.error.code).toBe('rate_limited');
    // An agent should be able to work out when to come back without reading English.
    expect(body.error.details.retryAfterSeconds).toBeGreaterThan(0);
    expect(stopped.headers.get('retry-after')).toBeTruthy();
  });

  it('does not take anybody else down with it', async () => {
    const server = serverWith({ MAX_PUBLISHES_PER_HOUR: '2' });
    const noisy = await signIn(server, 'noisy@example.com');
    const quiet = await signIn(server, 'quiet@example.com');

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await noisy.as('/api/artifacts', jsonBody({ type: 'markdown', content: `# ${attempt}` }));
    }

    const response = await quiet.as('/api/artifacts', jsonBody({ type: 'markdown', content: '# Mine' }));
    expect(response.status).toBe(201);
  });

  it('counts updates too, because a loop that republishes is the same loop', async () => {
    const server = serverWith({ MAX_PUBLISHES_PER_HOUR: '2' });
    const agent = await signIn(server, 'agent@example.com');

    const artifact = await agent.publish({ type: 'markdown', content: '# One' });

    const second = await agent.as(`/api/artifacts/${artifact.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '# Two', baseVersion: 1 }),
    });
    expect(second.status).toBe(200);

    const third = await agent.as(`/api/artifacts/${artifact.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '# Three', baseVersion: 2 }),
    });
    expect(third.status).toBe(429);
  });
});

describe('how much one person may keep', () => {
  it('refuses a new artifact past the count, and says what to do', async () => {
    const server = serverWith({ MAX_ARTIFACTS_PER_USER: '2' });
    const person = await signIn(server, 'person@example.com');

    await person.publish({ type: 'markdown', content: '# One' });
    await person.publish({ type: 'markdown', content: '# Two' });

    const response = await person.as('/api/artifacts', jsonBody({ type: 'markdown', content: '# Three' }));
    expect(response.status).toBe(400);
    expect(await messageOf(response)).toContain('Delete something first');
  });

  it('refuses one that would go over the storage allowed', async () => {
    const server = serverWith({ MAX_STORAGE_BYTES_PER_USER: '2048' });
    const person = await signIn(server, 'person@example.com');

    await person.publish({ type: 'markdown', content: 'x'.repeat(1500) });

    const response = await person.as(
      '/api/artifacts',
      jsonBody({ type: 'markdown', content: 'y'.repeat(1000) }),
    );
    expect(response.status).toBe(400);
    expect(await messageOf(response)).toContain('2.0 KB');
  });

  it('gives the room back when something is deleted', async () => {
    const server = serverWith({ MAX_ARTIFACTS_PER_USER: '1' });
    const person = await signIn(server, 'person@example.com');

    const first = await person.publish({ type: 'markdown', content: '# One' });
    expect(
      (await person.as('/api/artifacts', jsonBody({ type: 'markdown', content: '# Two' }))).status,
    ).toBe(400);

    await person.as(`/api/artifacts/${first.id}?confirm=true`, { method: 'DELETE' });

    expect(
      (await person.as('/api/artifacts', jsonBody({ type: 'markdown', content: '# Two' }))).status,
    ).toBe(201);
  });

  it('counts what is stored now, not every version ever kept', async () => {
    // Version history is ours for recovering from an accident. Billing somebody's
    // quota for it would punish them for republishing.
    const server = serverWith({ MAX_STORAGE_BYTES_PER_USER: '4096' });
    const person = await signIn(server, 'person@example.com');

    const artifact = await person.publish({ type: 'markdown', content: 'x'.repeat(1500) });
    for (let version = 1; version <= 2; version += 1) {
      await person.as(`/api/artifacts/${artifact.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'y'.repeat(1500), baseVersion: version }),
      });
    }

    // Three versions of 1500 bytes each, but only 1500 counted.
    const response = await person.as(
      '/api/artifacts',
      jsonBody({ type: 'markdown', content: 'z'.repeat(1500) }),
    );
    expect(response.status).toBe(201);
  });
});

describe('somebody using the instance as a mail relay', () => {
  it('is cut off after a few requests, whatever address they use', async () => {
    // Asking for a code sends mail to an address the caller chose, which is why
    // this is the tightest limit in the product and counts by caller, not by
    // address asked for.
    const server = serverWith({ MAX_AUTH_REQUESTS_PER_HOUR: '3' });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await server.request(
        '/api/auth/code',
        jsonBody({ email: `victim${attempt}@elsewhere.test` }),
      );
      expect(response.status).toBe(200);
    }

    const stopped = await server.request(
      '/api/auth/code',
      jsonBody({ email: 'victim99@elsewhere.test' }),
    );
    expect(stopped.status).toBe(429);
    expect(server.mailer.lastTo('victim99@elsewhere.test')).toBeUndefined();
  });

  it('also limits guessing codes, not just asking for them', async () => {
    const server = serverWith({ MAX_AUTH_REQUESTS_PER_HOUR: '2' });

    await server.request('/api/auth/code', jsonBody({ email: 'person@example.com' }));
    await server.request(
      '/api/auth/verify-code',
      jsonBody({ email: 'person@example.com', code: '000000' }),
    );

    const stopped = await server.request(
      '/api/auth/verify-code',
      jsonBody({ email: 'person@example.com', code: '111111' }),
    );
    expect(stopped.status).toBe(429);
  });
});

describe('commenting', () => {
  it('is limited too, so a loop cannot fill a thread', async () => {
    const server = serverWith({ MAX_COMMENTS_PER_HOUR: '2' });
    const owner = await signIn(server, 'owner@example.com');
    const artifact = await owner.publish({ type: 'markdown', content: '# Report' });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await owner.as(
        `/api/artifacts/${artifact.id}/comments`,
        jsonBody({ body: `Comment ${attempt}` }),
      );
      expect(response.status).toBe(201);
    }

    const stopped = await owner.as(
      `/api/artifacts/${artifact.id}/comments`,
      jsonBody({ body: 'One too many' }),
    );
    expect(stopped.status).toBe(429);
  });
});

describe('sharing, which also sends real mail', () => {
  it('is limited, so a signed-in person cannot use the instance as a relay', async () => {
    // Every new share emails an address the sharer chose. That is the same
    // mail-relay problem the sign-in limit exists for, one account further in.
    const server = serverWith({ MAX_SHARES_PER_HOUR: '2' });
    const owner = await signIn(server, 'owner@example.com');
    const artifact = await owner.publish({ type: 'markdown', content: '# Report' });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await owner.as(
        `/api/artifacts/${artifact.id}/sharing/people`,
        jsonBody({ email: `reader${attempt}@elsewhere.test` }),
      );
      expect(response.status).toBe(201);
    }

    const stopped = await owner.as(
      `/api/artifacts/${artifact.id}/sharing/people`,
      jsonBody({ email: 'victim@elsewhere.test' }),
    );
    expect(stopped.status).toBe(429);
    expect(server.mailer.lastTo('victim@elsewhere.test')).toBeUndefined();
  });
});

describe('a body far larger than anything we accept', () => {
  it('is refused before it is read, not after it is in memory', async () => {
    // The artifact size check runs on the parsed content, which is too late: by
    // then the whole thing has been buffered. A caller who says they are sending
    // a gigabyte should be turned away on the strength of saying it.
    const server = serverWith({ MAX_ARTIFACT_BYTES: '1024' });
    const person = await signIn(server, 'person@example.com');

    const response = await person.as('/api/artifacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(50 * 1024 * 1024) },
      body: JSON.stringify({ type: 'markdown', content: 'x'.repeat(200) }),
    });

    expect(response.status).toBe(413);
  });

  it('is refused even when the caller does not say how big it is', async () => {
    const server = serverWith({ MAX_ARTIFACT_BYTES: '1024' });
    const person = await signIn(server, 'person@example.com');

    const response = await person.as(
      '/api/artifacts',
      jsonBody({ type: 'markdown', content: 'x'.repeat(2 * 1024 * 1024) }),
    );

    expect(response.status).toBe(413);
  });

  it('leaves a body inside the limit alone', async () => {
    const server = serverWith({ MAX_ARTIFACT_BYTES: '1024' });
    const person = await signIn(server, 'person@example.com');

    const response = await person.as(
      '/api/artifacts',
      jsonBody({ type: 'markdown', content: '# Small enough' }),
    );

    expect(response.status).toBe(201);
  });
});

describe('one instance never limits another', () => {
  it('counts separately, so two servers in one process do not interfere', async () => {
    // Which is exactly what this test suite is. A shared counter would make
    // tests fail depending on what else had run.
    const first = serverWith({ MAX_PUBLISHES_PER_HOUR: '1' });
    const second = serverWith({ MAX_PUBLISHES_PER_HOUR: '1' });

    const onFirst = await signIn(first, 'person@example.com');
    const onSecond = await signIn(second, 'person@example.com');

    expect((await onFirst.as('/api/artifacts', jsonBody({ type: 'markdown', content: '# A' }))).status).toBe(201);
    expect((await onSecond.as('/api/artifacts', jsonBody({ type: 'markdown', content: '# B' }))).status).toBe(201);
  });
});

describe('the limits an operator can change', () => {
  it('are all configurable, with defaults sized for a team', async () => {
    const server = serverWith({});

    expect(server.config.limits).toEqual({
      artifactsPerUser: 500,
      storageBytesPerUser: 500 * 1024 * 1024,
      publishesPerHour: 120,
      commentsPerHour: 300,
      authRequestsPerHour: 20,
      sharesPerHour: 30,
    });
  });
});

async function messageOf(response: Response): Promise<string> {
  return ((await response.json()) as { error: { message: string } }).error.message;
}
