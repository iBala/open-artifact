import { test, expect, type Page } from '@playwright/test';
import { startServer, type RunningServer } from '../src/server.js';

/**
 * The security promise of this product, checked in a real browser.
 *
 * An artifact is written by an AI and read by a person who is signed in. If script
 * inside an artifact could read that person's session or call the API as them,
 * publishing an artifact would mean handing over an account.
 *
 * Response headers are not evidence on their own. These tests run the attack.
 */

let server: RunningServer;

test.beforeEach(async () => {
  server = await startServer();
});

test.afterEach(async () => {
  await server.stop();
});

/**
 * An artifact that tries every way out it has and reports what happened. This
 * stands in for a hostile artifact; if any attempt succeeds, the test fails.
 */
const ATTACKER_HTML = `<!doctype html>
<html><body>
<h1>Looks like a dashboard</h1>
<script>
  const result = { cookie: null, cookieError: null, fetch: null, storageError: null, origin: null };

  try { result.origin = String(window.origin); } catch (error) { result.origin = 'threw'; }

  try { result.cookie = document.cookie; }
  catch (error) { result.cookieError = String(error && error.name); }

  try { localStorage.getItem('x'); }
  catch (error) { result.storageError = String(error && error.name); }

  fetch('/api/artifacts', { credentials: 'include' })
    .then((response) => response.text().then((body) => {
      result.fetch = { ok: response.ok, status: response.status, body: body.slice(0, 200) };
    }))
    .catch((error) => { result.fetch = { blocked: true, error: String(error && error.message) }; })
    .finally(() => {
      window.__attackResult = result;
      try { parent.postMessage(result, '*'); } catch (error) { /* parent is out of reach too */ }
    });
</script>
</body></html>`;

test('a signed-in reader’s cookie is unreachable from inside an artifact', async ({
  page,
  context,
}) => {
  // Give the browser a session cookie for this origin, the way signing in would.
  await context.addCookies([
    {
      name: 'oa_session',
      value: 'pretend-session-value',
      url: server.baseUrl,
      httpOnly: false, // The easiest possible cookie to steal. It still must not be readable.
    },
  ]);

  const artifact = await server.publish({ type: 'html', content: ATTACKER_HTML });
  await page.goto(`${server.baseUrl}/a/${artifact.slug}`);

  const frame = page.frameLocator('iframe');
  await expect(frame.locator('h1')).toHaveText('Looks like a dashboard');

  const result = await readAttackResult(page);

  // The frame runs at an opaque origin, which is what makes the rest hold.
  expect(result.origin).toBe('null');

  // Reading the cookie throws outright, rather than returning an empty string.
  // Asserted explicitly so this test cannot pass just because the attack script
  // failed to run at all.
  expect(result.cookieError).toBe('SecurityError');
  expect(result.cookie ?? '').not.toContain('pretend-session-value');

  // Same story for local storage.
  expect(result.storageError).toBe('SecurityError');
});

test('artifact script cannot call the API, even asking for credentials', async ({
  page,
  context,
}) => {
  await context.addCookies([
    { name: 'oa_session', value: 'pretend-session-value', url: server.baseUrl },
  ]);

  const artifact = await server.publish({ type: 'html', content: ATTACKER_HTML });
  await page.goto(`${server.baseUrl}/a/${artifact.slug}`);
  await expect(page.frameLocator('iframe').locator('h1')).toBeVisible();

  const result = await readAttackResult(page);

  // The attempt must have been made and reported, or this test proves nothing.
  expect(result.fetch).toBeTruthy();

  // Either the request never left the frame (CSP connect-src 'none') or it was
  // refused. What must never happen is a successful, authenticated response.
  if (result.fetch?.blocked) {
    expect(result.fetch.error).toBeTruthy();
  } else {
    expect(result.fetch?.ok).toBe(false);
    // No artifact ids in the body: that would mean it read someone's list.
    expect(result.fetch?.body ?? '').not.toContain('art_');
  }
});

test('the same limits apply when the content URL is opened directly in a tab', async ({
  page,
  context,
}) => {
  // The iframe's sandbox attribute does nothing here. Only the response's own
  // Content-Security-Policy sandbox directive stands between the artifact and
  // the reader's session.
  await context.addCookies([
    { name: 'oa_session', value: 'pretend-session-value', url: server.baseUrl },
  ]);

  const artifact = await server.publish({ type: 'html', content: ATTACKER_HTML });
  await page.goto(`${server.baseUrl}/a/${artifact.slug}/content`);
  await expect(page.locator('h1')).toBeVisible();

  const result = await page.waitForFunction(
    () => (window as unknown as { __attackResult?: AttackResult }).__attackResult,
  );
  const value = (await result.jsonValue()) as AttackResult;

  expect(value.origin).toBe('null');
  expect(value.cookieError).toBe('SecurityError');
  expect(value.cookie ?? '').not.toContain('pretend-session-value');
  expect(value.fetch).toBeTruthy();
  if (!value.fetch?.blocked) {
    expect(value.fetch?.ok).toBe(false);
  }
});

test('an artifact cannot reach into the page around it', async ({ page }) => {
  const prober = `<!doctype html><html><body><h1>Prober</h1><script>
    let reachedParent = false;
    try { reachedParent = typeof parent.document.title === 'string'; } catch (error) { reachedParent = false; }
    window.__attackResult = { cookie: null, reachedParent };
  </script></body></html>`;

  const artifact = await server.publish({ type: 'html', content: prober });
  await page.goto(`${server.baseUrl}/a/${artifact.slug}`);
  await expect(page.frameLocator('iframe').locator('h1')).toBeVisible();

  const result = await readAttackResult(page);
  expect(result.reachedParent).toBe(false);
});

test('script in a Markdown artifact never runs, because it never reaches the page', async ({
  page,
}) => {
  const artifact = await server.publish({
    type: 'markdown',
    content: '# Report\n\n<script>window.__markdownScriptRan = true;</script>\n\nBody text.',
  });

  await page.goto(`${server.baseUrl}/a/${artifact.slug}`);
  await expect(page.locator('article.prose h1')).toHaveText('Report');
  await expect(page.getByText('Body text.')).toBeVisible();

  expect(
    await page.evaluate(() => (window as unknown as { __markdownScriptRan?: boolean }).__markdownScriptRan),
  ).toBeUndefined();
});

interface AttackResult {
  cookie: string | null;
  origin?: string | null;
  cookieError?: string | null;
  storageError?: string | null;
  reachedParent?: boolean;
  fetch?: {
    ok?: boolean;
    status?: number;
    body?: string;
    blocked?: boolean;
    error?: string;
  } | null;
}

/** Reads what the artifact managed to do, from inside the frame. */
async function readAttackResult(page: Page): Promise<AttackResult> {
  const frame = page.frames().find((candidate) => candidate !== page.mainFrame());
  if (!frame) throw new Error('the artifact frame is missing');

  const handle = await frame.waitForFunction(
    () => (window as unknown as { __attackResult?: AttackResult }).__attackResult,
  );
  return (await handle.jsonValue()) as AttackResult;
}
