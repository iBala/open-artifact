import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestServer, TEST_BASE_URL, type TestServer } from './helpers/server.js';

/**
 * The hosted setup instructions at /setup.md.
 *
 * This is the first thing an assistant fetches, before it has any session, so it
 * has to be public and it has to point at this instance rather than at
 * open-artifact.com. Both are properties a self-hoster depends on.
 */

let server: TestServer;

beforeEach(() => {
  server = createTestServer();
});

afterEach(() => {
  server.close();
});

describe('/setup.md', () => {
  it('is served publicly, as markdown', async () => {
    const response = await server.request('/setup.md');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/markdown');
  });

  it('points at this instance, not a hardcoded one', async () => {
    const body = await (await server.request('/setup.md')).text();
    // The instance URL is woven through the install, login and connector steps.
    expect(body).toContain(`${TEST_BASE_URL}/mcp`);
    expect(body).toContain(`open-artifact login --instance ${TEST_BASE_URL}`);
    expect(body).not.toContain('open-artifact.com');
  });

  it('carries the steps an assistant needs to set itself up', async () => {
    const body = await (await server.request('/setup.md')).text();
    expect(body).toContain('npm install -g open-artifact --registry https://registry.npmjs.org/');
    expect(body).toContain('open-artifact whoami --json');
  });

  it('answers /setup as an alias', async () => {
    const response = await server.request('/setup');
    expect(response.status).toBe(200);
  });
});

describe('/llms.txt', () => {
  it('is served publicly, as plain text', async () => {
    const response = await server.request('/llms.txt');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
  });

  it('describes the project and points at this instance', async () => {
    const body = await (await server.request('/llms.txt')).text();
    expect(body).toContain('# Open Artifact');
    expect(body).toContain(`${TEST_BASE_URL}/setup.md`);
    expect(body).toContain('github.com/iBala/open-artifact');
    // Instance URLs are dynamic; the hardcoded prod address must not leak in.
    // (The hello@open-artifact.com support address is a fixed contact, not an
    // instance URL, so it is allowed.)
    expect(body).not.toContain('https://open-artifact.com');
  });

  it('answers /llm.txt as an alias', async () => {
    const response = await server.request('/llm.txt');
    expect(response.status).toBe(200);
  });
});
