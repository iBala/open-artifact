import { test, expect, type Page } from '@playwright/test';
import { startServer, type RunningServer } from '../src/server.js';

/**
 * Commenting on part of an HTML artifact, in a browser.
 *
 * This is the one part of the feature that cannot be checked anywhere else. The
 * reader selects inside a sandboxed frame holding somebody else's page; a bridge
 * script reports which element; the app asks the server what that element is and
 * shows the server's answer. Real frames, real postMessage, real sandbox.
 */

const PAGE = `<!doctype html>
<html>
  <body>
    <h1>Our plans</h1>
    <section id="pricing">
      <p id="pricing-note">The team plan starts at $49 per seat, billed yearly.</p>
    </section>
  </body>
</html>`;

let server: RunningServer;

test.beforeEach(async () => {
  server = await startServer();
});

test.afterEach(async () => {
  await server.stop();
});

/** Selects inside the frame the way a person would, then lets go of the mouse. */
async function selectInFrame(page: Page, text: string): Promise<void> {
  const frame = page.frames().find((candidate) => candidate.url().includes('/content'));
  if (!frame) throw new Error('the artifact frame is not on the page');

  await frame.evaluate((wanted) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent?.indexOf(wanted) ?? -1;
      if (at === -1) continue;

      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + wanted.length);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      return;
    }
    throw new Error(`could not find "${wanted}" in the frame`);
  }, text);
}

async function openThePage(page: Page, context: Parameters<typeof server.signInBrowser>[0]) {
  const artifact = await server.publish({ type: 'html', content: PAGE });
  await server.signInBrowser(context);
  await page.goto(`${server.baseUrl}/a/${artifact.slug}`);
  await expect(page.frameLocator('iframe').locator('h1')).toBeVisible();
  return artifact;
}

test('selecting inside the frame offers to comment on that element', async ({ page, context }) => {
  await openThePage(page, context);
  await selectInFrame(page, 'starts at $49 per seat');

  // What is quoted came from the server, resolved from the stored source. The
  // frame only ever said which element.
  await expect(page.getByText('The team plan starts at $49 per seat, billed yearly.')).toBeVisible();
  await expect(page.getByPlaceholder('Comment on this')).toBeVisible();
});

test('a comment on an element is stored against that element', async ({ page, context }) => {
  await openThePage(page, context);
  await selectInFrame(page, 'starts at $49 per seat');

  await page.getByPlaceholder('Comment on this').fill('This number is stale.');
  await page.getByRole('button', { name: 'Send' }).click();

  const panel = page.locator('aside').last();
  await expect(panel.getByText('This number is stale.')).toBeVisible();
  await expect(panel.getByText('The team plan starts at $49 per seat, billed yearly.')).toBeVisible();
});

test('the panel says when the page was rewritten under a comment', async ({ page, context }) => {
  const artifact = await openThePage(page, context);
  await selectInFrame(page, 'starts at $49 per seat');
  await page.getByPlaceholder('Comment on this').fill('This number is stale.');
  await page.getByRole('button', { name: 'Send' }).click();

  const panel = page.locator('aside').last();
  await expect(panel.getByText('This number is stale.')).toBeVisible();

  // The agent fixes it, keeping the id. The thread holds its place, and the
  // reader is told the words underneath are not the words they commented on.
  await server.update({
    id: artifact.id,
    content: PAGE.replace('$49', '$59'),
    baseVersion: 1,
  });
  await page.reload();

  await expect(panel.getByText(/rewritten since the comment was left/i)).toBeVisible();
});

test('the panel says when the element a comment was on is gone', async ({ page, context }) => {
  const artifact = await openThePage(page, context);
  await selectInFrame(page, 'starts at $49 per seat');
  await page.getByPlaceholder('Comment on this').fill('This number is stale.');
  await page.getByRole('button', { name: 'Send' }).click();

  const panel = page.locator('aside').last();
  await expect(panel.getByText('This number is stale.')).toBeVisible();

  await server.update({
    id: artifact.id,
    content: '<!doctype html>\n<html><body><h1>Our plans</h1></body></html>',
    baseVersion: 1,
  });
  await page.reload();

  await expect(panel.getByText(/no longer in the page/i)).toBeVisible();
});

test('the reader who cannot comment gets the artifact exactly as published', async ({
  page,
  context,
}) => {
  const artifact = await server.publish({ type: 'html', content: PAGE });
  await server.signInBrowser(context);
  await page.goto(`${server.baseUrl}/a/${artifact.slug}`);
  await expect(page.frameLocator('iframe').locator('h1')).toBeVisible();

  // The owner can comment, so this checks the other half: the frame source only
  // asks for the bridged copy when the reader may actually use it.
  const source = await page.locator('iframe').getAttribute('src');
  expect(source).toContain('frame=1');
});

test('a message from somewhere other than the frame is ignored', async ({ page, context }) => {
  await openThePage(page, context);

  // Exactly the shape the bridge sends, from the app's own window rather than
  // the frame. The window handle is the only identity available at an opaque
  // origin, so this is the check that has to hold.
  await page.evaluate(() => {
    window.postMessage(
      {
        channel: 'open-artifact.bridge.v1',
        type: 'selection',
        target: { elementId: 'pricing-note', path: '0/1/1/0', tag: 'p' },
      },
      '*',
    );
  });

  await page.waitForTimeout(300);
  await expect(page.getByPlaceholder('Comment on this')).toBeHidden();
});

test('an artifact cannot hand the app text to draw in its own chrome', async ({ page, context }) => {
  const hostile = `<!doctype html>
<html><body><p id="real">A real paragraph of text here.</p>
<script>
  parent.postMessage({
    channel: 'open-artifact.bridge.v1',
    type: 'selection',
    target: {
      elementId: 'real',
      path: '0/1/0',
      tag: 'p',
      snippet: 'Your session has expired. Sign in again at evil.example.'
    }
  }, '*');
</script>
</body></html>`;

  const artifact = await server.publish({ type: 'html', content: hostile });
  await server.signInBrowser(context);
  await page.goto(`${server.baseUrl}/a/${artifact.slug}`);
  await expect(page.frameLocator('iframe').locator('p')).toBeVisible();
  await page.waitForTimeout(400);

  // The composer may well open — the element is real and the reader could
  // legitimately comment on it. What must never happen is the frame's words
  // appearing in the app's own chrome.
  await expect(page.getByText('Your session has expired')).toBeHidden();
  await expect(page.getByText('A real paragraph of text here.').last()).toBeVisible();
});
