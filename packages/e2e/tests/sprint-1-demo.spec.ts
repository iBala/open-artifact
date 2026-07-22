import { test, expect } from '@playwright/test';
import { startServer, E2E_TOKEN, type RunningServer } from '../src/server.js';

/**
 * Sprint 1's demo, run as a test.
 *
 * Publish a Markdown report and an HTML dashboard over HTTP the way any client
 * would, read both in a browser, re-publish one, and watch a stale update get
 * turned away. If this passes, the sprint is genuinely done.
 */

let server: RunningServer;

test.beforeEach(async () => {
  server = await startServer();
});

test.afterEach(async () => {
  await server.stop();
});

const REPORT = `# Quarterly report

Revenue is up. Details below.

| Region | Revenue |
| --- | --- |
| India | 42 |
| Europe | 17 |

- [x] Numbers checked
- [ ] Sent to the board
`;

const DASHBOARD = `<!doctype html>
<html><head><title>Live dashboard</title></head>
<body>
  <h1>Live dashboard</h1>
  <p id="count">counting…</p>
  <script>document.getElementById('count').textContent = 'Rendered by the artifact’s own script';</script>
</body></html>`;

test('publish two artifacts, read them, update one, and get stopped on a stale update', async ({
  page,
}) => {
  // Publish a Markdown report.
  const report = await server.publish({ type: 'markdown', content: REPORT });
  expect(report.title).toBe('Quarterly report');
  expect(report.url).toBe(`${server.baseUrl}/a/${report.slug}`);

  // Publish an HTML dashboard.
  const dashboard = await server.publish({ type: 'html', content: DASHBOARD });
  expect(dashboard.title).toBe('Live dashboard');

  // The Markdown renders as GitHub Flavored Markdown, in the page.
  await page.goto(report.url);
  await expect(page.locator('article.prose h1')).toHaveText('Quarterly report');
  await expect(page.locator('article.prose table td').first()).toHaveText('India');
  await expect(page.locator('article.prose input[type=checkbox]').first()).toBeChecked();

  // The HTML runs its own script, contained in the frame.
  await page.goto(dashboard.url);
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('h1')).toHaveText('Live dashboard');
  await expect(frame.locator('#count')).toHaveText('Rendered by the artifact’s own script');

  // Re-publishing updates the same URL rather than creating a second one.
  const updated = await update(report.id, { content: '# Quarterly report v2', baseVersion: 1 });
  expect(updated.status).toBe(200);
  expect(((await updated.json()) as { slug: string }).slug).toBe(report.slug);

  await page.goto(report.url);
  await expect(page.locator('article.prose h1')).toHaveText('Quarterly report v2');

  // A second publisher still holding version 1 is turned away, not merged over.
  const stale = await update(report.id, { content: '# Clobbered', baseVersion: 1 });
  expect(stale.status).toBe(409);
  expect(((await stale.json()) as { error: { code: string } }).error.code).toBe('version_conflict');

  // And the artifact still says what the successful update said.
  await page.goto(report.url);
  await expect(page.locator('article.prose h1')).toHaveText('Quarterly report v2');
});

async function update(id: string, body: unknown): Promise<Response> {
  return fetch(`${server.baseUrl}/api/artifacts/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${E2E_TOKEN}` },
    body: JSON.stringify(body),
  });
}
