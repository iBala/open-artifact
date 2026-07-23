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
