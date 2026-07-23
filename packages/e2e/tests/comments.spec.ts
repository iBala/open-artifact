import { test, expect, type Page } from '@playwright/test';
import { startServer, type RunningServer } from '../src/server.js';

/**
 * Commenting, in a browser.
 *
 * The part that can only be checked here is turning a highlighted passage into
 * an anchor. The client counts which occurrence of the text was selected and the
 * server recounts it independently, refusing anything that does not match. Those
 * two counts have to agree, and only a real DOM selection proves they do.
 */

const REPORT = `# Quarterly review

Revenue is up eighteen percent on the quarter. See the note below.

## Europe

Europe was flat this quarter. See the note below.
`;

let server: RunningServer;

test.beforeEach(async () => {
  server = await startServer();
});

test.afterEach(async () => {
  await server.stop();
});

/**
 * Highlights a passage the way a person would, then tells the page about it.
 *
 * Built with the browser's own Selection API rather than by dragging, because a
 * drag across wrapped text is unreliable and this is exactly what the code reads.
 */
async function highlight(page: Page, text: string): Promise<void> {
  await page.evaluate((wanted) => {
    const article = document.querySelector('article.prose');
    if (!article) throw new Error('no article on the page');

    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent?.indexOf(wanted) ?? -1;
      if (at === -1) continue;

      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + wanted.length);

      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return;
    }
    throw new Error(`could not find "${wanted}" in the document`);
  }, text);

  await page.locator('article.prose').dispatchEvent('mouseup');
}

/**
 * Highlights a passage and opens the composer on it.
 *
 * Highlighting alone now only offers a small "Comment" button — so a reader can
 * still copy — and the composer opens when it is pressed. Matched with exact so
 * it never catches the bar's "Comments" toggle.
 */
async function selectText(page: Page, text: string): Promise<void> {
  await highlight(page, text);
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
}

async function openTheReport(page: Page, context: Parameters<typeof server.signInBrowser>[0]) {
  const artifact = await server.publish({ type: 'markdown', content: REPORT });
  await server.signInBrowser(context);
  await page.goto(`${server.baseUrl}/a/${artifact.slug}`);
  await expect(page.locator('article.prose h1')).toBeVisible();
  return artifact;
}

test('highlighting a passage offers to comment, without stealing the selection', async ({
  page,
  context,
}) => {
  await openTheReport(page, context);

  await highlight(page, 'Europe was flat this quarter');

  // First stage: only a small button, so the highlight stays live and copyable.
  // The composer, which grabs focus, must not have opened on its own.
  await expect(page.getByRole('button', { name: 'Comment', exact: true })).toBeVisible();
  await expect(page.getByPlaceholder('Comment on this')).toBeHidden();

  // Pressing it opens the composer, which shows what the comment is about, so
  // nobody comments on the wrong thing by accident.
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(page.getByPlaceholder('Comment on this')).toBeVisible();
  await expect(page.getByText('Europe was flat this quarter').last()).toBeVisible();
});

test('a comment on a passage is stored against that passage', async ({ page, context }) => {
  await openTheReport(page, context);

  await selectText(page, 'Europe was flat this quarter');
  await page.getByPlaceholder('Comment on this').fill('Is this figure right?');
  await page.getByRole('button', { name: 'Send' }).click();

  const panel = page.locator('aside').last();
  await expect(panel.getByText('Is this figure right?')).toBeVisible();
  await expect(panel.getByText('Europe was flat this quarter')).toBeVisible();
});

test('the client and the server agree on which occurrence was selected', async ({
  page,
  context,
}) => {
  // "See the note below." appears twice, under different headings. Commenting on
  // the second must be recorded as the second: if the two sides counted
  // differently the server would refuse it, or worse, store the wrong one.
  await openTheReport(page, context);

  await page.evaluate(() => {
    const article = document.querySelector('article.prose');
    const paragraphs = article ? Array.from(article.querySelectorAll('p')) : [];
    // The one under the Europe heading, which is the second in the document.
    const target = paragraphs[1];
    if (!target) throw new Error('expected a second paragraph');

    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
    const node = walker.nextNode();
    if (!node) throw new Error('no text');

    const at = node.textContent?.indexOf('See the note below.') ?? -1;
    const range = document.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + 'See the note below.'.length);

    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await page.locator('article.prose').dispatchEvent('mouseup');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();

  await page.getByPlaceholder('Comment on this').fill('Which note?');
  await page.getByRole('button', { name: 'Send' }).click();

  // Accepted, rather than refused as an anchor that does not match.
  await expect(page.locator('aside').last().getByText('Which note?')).toBeVisible();
});

test('a comment about the whole document needs no selection', async ({ page, context }) => {
  await openTheReport(page, context);

  await page.getByRole('button', { name: 'Comment on the whole document' }).click();
  await page.getByPlaceholder('A note about the whole document').fill('Reads well.');
  await page.getByRole('button', { name: 'Send' }).click();

  await expect(page.locator('aside').last().getByText('Reads well.')).toBeVisible();
});

test('replying, resolving and reopening a thread', async ({ page, context }) => {
  await openTheReport(page, context);

  await selectText(page, 'Europe was flat this quarter');
  await page.getByPlaceholder('Comment on this').fill('Is this right?');
  await page.getByRole('button', { name: 'Send' }).click();

  const panel = page.locator('aside').last();
  await expect(panel.getByText('Is this right?')).toBeVisible();

  await panel.getByRole('button', { name: 'Reply' }).click();
  await page.getByPlaceholder('Reply').fill('Checked, it is correct.');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(panel.getByText('Checked, it is correct.')).toBeVisible();

  // Resolving collapses it rather than hiding it: somebody scrolling back
  // wants to see that a question was asked and answered.
  await panel.getByRole('button', { name: 'Resolve' }).click();
  await expect(panel.getByText('1 resolved')).toBeVisible();
  await expect(panel.getByText('Is this right?')).toBeHidden();

  await panel.getByRole('button', { name: '1 resolved' }).click();
  await expect(panel.getByText('Is this right?')).toBeVisible();
  await panel.getByRole('button', { name: 'Reopen' }).click();
  await expect(panel.getByText('1 resolved')).toBeHidden();
});

test('editing marks the comment as edited, and deleting removes it', async ({ page, context }) => {
  await openTheReport(page, context);

  await page.getByRole('button', { name: 'Comment on the whole document' }).click();
  await page.getByPlaceholder('A note about the whole document').fill('Reeds well.');
  await page.getByRole('button', { name: 'Send' }).click();

  const panel = page.locator('aside').last();
  await panel.getByText('Reeds well.').hover();
  await panel.getByRole('button', { name: 'Edit' }).click();
  await page.getByPlaceholder('Edit').fill('Reads well.');
  await page.getByRole('button', { name: 'Send' }).click();

  await expect(panel.getByText('Reads well.')).toBeVisible();
  await expect(panel.getByText('(edited)')).toBeVisible();

  await panel.getByText('Reads well.').hover();
  await panel.getByRole('button', { name: 'Delete' }).click();
  await expect(panel.getByText('Reads well.')).toBeHidden();
});

test('somebody who can only read cannot comment', async ({ page, context }) => {
  const artifact = await server.publish({ type: 'markdown', content: REPORT });
  await server.as(`/api/artifacts/${artifact.id}/sharing/public`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ isPublic: true }),
  });

  // A passer-by on a public artifact. Reading is open to the world; a comment
  // box open to the world is a different product.
  const cookie = await server.signInAs('passerby@elsewhere.test');
  await context.addCookies([
    { name: 'oa_session', value: cookie.split('=').slice(1).join('='), url: server.baseUrl },
  ]);

  await page.goto(`${server.baseUrl}/a/${artifact.slug}`);
  await expect(page.locator('article.prose h1')).toBeVisible();

  // Highlighting offers a reader nothing: no Comment button, no composer, and no
  // way to comment on the whole document either.
  await highlight(page, 'Europe was flat this quarter');
  await expect(page.getByRole('button', { name: 'Comment', exact: true })).toBeHidden();
  await expect(page.getByPlaceholder('Comment on this')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Comment on the whole document' })).toBeHidden();
});

test('a comment says so when its passage is gone after a re-publish', async ({ page, context }) => {
  const artifact = await openTheReport(page, context);

  await selectText(page, 'Europe was flat this quarter');
  await page.getByPlaceholder('Comment on this').fill('Is this right?');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('aside').last().getByText('Is this right?')).toBeVisible();

  // The author rewrites the passage the comment was about.
  await server.as(`/api/artifacts/${artifact.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: REPORT.replace('Europe was flat this quarter.', 'Europe grew nine percent.'),
      baseVersion: 1,
    }),
  });

  await page.reload();

  // Said out loud, rather than the comment quietly appearing to be about
  // whatever text now sits where it used to point.
  await expect(page.getByText(/no longer in the document/i)).toBeVisible();
  await expect(page.locator('aside').last().getByText('Is this right?')).toBeVisible();
});
