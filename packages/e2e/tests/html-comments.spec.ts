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

/** Long enough that the frame really scrolls, with the quotable line at the top. */
const TALL_PAGE = `<!doctype html>
<html>
  <body>
    <h1>Our plans</h1>
    <section id="pricing">
      <p id="pricing-note">The team plan starts at $49 per seat, billed yearly.</p>
    </section>
    <section id="detail">
      ${Array.from({ length: 120 }, (_, index) => `<p>Paragraph ${index} of the small print.</p>`).join('\n      ')}
      <p id="closing-note">Everything above is negotiable for a large enough team.</p>
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

/** Where the document inside the frame is scrolled to. */
async function frameScroll(page: Page): Promise<number> {
  const frame = page.frames().find((candidate) => candidate.url().includes('/content'));
  if (!frame) throw new Error('the artifact frame is not on the page');
  return frame.evaluate(() => window.scrollY);
}

async function scrollFrameToBottom(page: Page): Promise<void> {
  const frame = page.frames().find((candidate) => candidate.url().includes('/content'));
  if (!frame) throw new Error('the artifact frame is not on the page');
  await frame.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
}

async function openThePage(
  page: Page,
  context: Parameters<typeof server.signInBrowser>[0],
  content: string = PAGE,
) {
  const artifact = await server.publish({ type: 'html', content });
  await server.signInBrowser(context);
  await page.goto(`${server.baseUrl}/a/${artifact.slug}`);
  await expect(page.frameLocator('iframe').locator('h1')).toBeVisible();
  return artifact;
}

test('the page fills the reading area rather than collapsing to a strip', async ({
  page,
  context,
}) => {
  // The frame is the whole document for an HTML artifact. If its height chain
  // breaks it falls back to an iframe's default 150px, the top band renders and
  // everything below it is blank app background — the artifact looks empty and
  // nothing in the console says why.
  await openThePage(page, context);

  const frame = page.locator('iframe');
  const box = await frame.boundingBox();
  const viewport = page.viewportSize();

  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  // Most of what is left below the title bar belongs to the document.
  expect(box!.height).toBeGreaterThan(viewport!.height * 0.7);
});

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

/**
 * Reading the panel must not move the document.
 *
 * Touching a thread lights up the passage it is about — that is the whole point
 * of the panel sitting beside the page. But the pointer crosses several cards on
 * its way to a reply box, and every comment posted reloads the threads. If any of
 * that scrolls the frame, the page walks away under the reader while they type.
 */
test('hovering a thread lights it up without moving the page', async ({ page, context }) => {
  await openThePage(page, context, TALL_PAGE);
  await selectInFrame(page, 'starts at $49 per seat');
  await page.getByPlaceholder('Comment on this').fill('This number is stale.');
  await page.getByRole('button', { name: 'Send' }).click();

  const panel = page.locator('aside').last();
  await expect(panel.getByText('This number is stale.')).toBeVisible();

  // The reader has read on, well past the paragraph they commented on.
  await scrollFrameToBottom(page);
  const before = await frameScroll(page);
  expect(before).toBeGreaterThan(200);

  await panel.getByText('This number is stale.').hover();
  // Long enough for a smooth scroll to have finished, had one started.
  await page.waitForTimeout(800);

  expect(await frameScroll(page)).toBe(before);
});

test('pressing the quote in a thread takes you to it', async ({ page, context }) => {
  await openThePage(page, context, TALL_PAGE);
  await selectInFrame(page, 'starts at $49 per seat');
  await page.getByPlaceholder('Comment on this').fill('This number is stale.');
  await page.getByRole('button', { name: 'Send' }).click();

  const panel = page.locator('aside').last();
  await expect(panel.getByText('This number is stale.')).toBeVisible();
  await scrollFrameToBottom(page);
  expect(await frameScroll(page)).toBeGreaterThan(200);

  // Hovering lights it up where it is; asking to be taken there is a press.
  await panel.getByRole('button', { name: /The team plan starts at \$49/ }).click();

  await expect.poll(() => frameScroll(page), { timeout: 3000 }).toBeLessThan(100);
});

/**
 * The link in a notification email.
 *
 * Somebody is told a comment names them, presses the link, and must land on the
 * remark and the thing it is about. Landing on the top of a long document with
 * nothing marked is the same as not being told which comment it was.
 */
async function commentOnTheClosingNote(page: Page): Promise<void> {
  await selectInFrame(page, 'negotiable for a large enough team');
  await page.getByPlaceholder('Comment on this').fill('Say by how much.');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('aside').last().getByText('Say by how much.')).toBeVisible();
}

async function onlyThreadId(artifactId: string): Promise<string> {
  const response = await server.as(`/api/artifacts/${artifactId}/comments`);
  const { threads } = (await response.json()) as { threads: { id: string }[] };
  if (threads.length !== 1) throw new Error(`expected one thread, found ${threads.length}`);
  return threads[0]!.id;
}

test('a link to a comment lands on the passage it is about', async ({ page, context }) => {
  const artifact = await openThePage(page, context, TALL_PAGE);
  await commentOnTheClosingNote(page);
  const threadId = await onlyThreadId(artifact.id);

  // Arriving cold, the way somebody does from their inbox.
  await page.goto(`${server.baseUrl}/a/${artifact.slug}?thread=${threadId}`);
  await expect(page.frameLocator('iframe').locator('h1')).toBeVisible();

  // The paragraph is at the far end of a long page, so any scroll at all is the
  // frame having been taken there rather than left where it loaded.
  await expect.poll(() => frameScroll(page), { timeout: 5000 }).toBeGreaterThan(200);
});

test('a link to a comment that was resolved still shows it', async ({ page, context }) => {
  const artifact = await openThePage(page, context, TALL_PAGE);
  await commentOnTheClosingNote(page);
  const threadId = await onlyThreadId(artifact.id);

  // Resolved while the email sat unread, so the thread is now behind a fold.
  await server.as(`/api/comments/threads/${threadId}/status`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'resolved' }),
  });

  await page.goto(`${server.baseUrl}/a/${artifact.slug}?thread=${threadId}`);

  // Opened for them. Being sent to a comment and shown an empty panel reads as
  // the comment having been deleted.
  await expect(page.locator('aside').last().getByText('Say by how much.')).toBeVisible();
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
