import { test, expect, type Page } from '@playwright/test';
import { startServer, type RunningServer } from '../src/server.js';

/**
 * Editing a Markdown artifact in place, in a browser.
 *
 * Everything below needs a real DOM. The web package tests the pure decisions
 * (which range a click resolves to, whether two versions agree, what a failed
 * save says) but cannot test the part that binds them to a page: whether the
 * click listener is attached to the right element at the right time, whether
 * the textarea holds the Markdown or the rendered words, and whether typed text
 * really survives a conflict.
 *
 * The last of those is the one that matters most. A save can fail, and when it
 * does the reader must not lose what they just wrote.
 */

const REPORT = `# Quarterly review

Revenue is up eighteen percent on the quarter.

## Europe

Europe was flat this quarter.

| Region | Growth |
| --- | --- |
| India | 31% |
`;

let server: RunningServer;

test.beforeEach(async () => {
  server = await startServer();
});

test.afterEach(async () => {
  await server.stop();
});

/** Opens an artifact as its owner, signed in. */
async function openAsOwner(page: Page, slug: string): Promise<void> {
  await server.signInBrowser(page.context());
  await page.goto(`${server.baseUrl}/a/${slug}`);
  await expect(page.locator('article.prose')).toBeVisible();
}

/**
 * Turns edit mode on from the bar and waits until blocks are live.
 *
 * Editing announces itself by marking the document rather than by printing an
 * instruction, so this waits on the article, not on a notice.
 */
async function startEditing(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.locator('article.prose[data-oa-editing]')).toBeAttached();
  await expect(page.getByRole('button', { name: 'Source', exact: true })).toBeVisible();
}

/** The textarea for whichever block is open. */
function blockBox(page: Page) {
  return page.getByLabel('Markdown source for this block');
}

test('an owner fixes a typo without leaving the page', async ({ page }) => {
  const artifact = await server.publish({ type: 'markdown', content: REPORT });
  await openAsOwner(page, artifact.slug);
  await startEditing(page);

  await page.locator('article.prose p', { hasText: 'Revenue is up' }).click();

  // The box holds Markdown source, not the rendered words.
  await expect(blockBox(page)).toHaveValue('Revenue is up eighteen percent on the quarter.');

  await blockBox(page).fill('Revenue is up nineteen percent on the quarter.');
  await page.getByRole('button', { name: 'Save' }).click();

  await expect(page.locator('article.prose')).toContainText('nineteen percent');
  await expect(page.locator('article.prose')).not.toContainText('eighteen percent');

  // Edit mode stays on, so a run of small fixes does not mean turning it back on
  // between each one.
  await expect(page.locator('article.prose[data-oa-editing]')).toBeAttached();
});

test('the Markdown syntax of a block travels with it', async ({ page }) => {
  const artifact = await server.publish({ type: 'markdown', content: REPORT });
  await openAsOwner(page, artifact.slug);
  await startEditing(page);

  // A heading keeps its marker, so editing one cannot silently demote it.
  await page.locator('article.prose h2').click();
  await expect(blockBox(page)).toHaveValue('## Europe');
  await page.keyboard.press('Escape');

  // A table keeps its pipes and its alignment row.
  await page.locator('article.prose table').click();
  await expect(blockBox(page)).toHaveValue(
    '| Region | Growth |\n| --- | --- |\n| India | 31% |',
  );
});

test('clicking inside a block edits the block, not the bit that was clicked', async ({ page }) => {
  const artifact = await server.publish({
    type: 'markdown',
    content: '# Title\n\nA paragraph with **bold** inside it.\n',
  });
  await openAsOwner(page, artifact.slug);
  await startEditing(page);

  await page.locator('article.prose strong').click();
  await expect(blockBox(page)).toHaveValue('A paragraph with **bold** inside it.');
});

test('a conflicting save keeps the typed text', async ({ page }) => {
  // The failure this feature must never have. Somebody types, the document moves
  // under them, and the save is refused. Their words stay in the box.
  const artifact = await server.publish({ type: 'markdown', content: REPORT });
  await openAsOwner(page, artifact.slug);
  await startEditing(page);

  await page.locator('article.prose p', { hasText: 'Revenue is up' }).click();
  await blockBox(page).fill('Revenue is up twenty percent, and I typed this by hand.');

  // An agent republishes while the box is open.
  await server.update({
    id: artifact.id,
    content: REPORT.replace('Europe was flat', 'Europe grew slightly'),
    baseVersion: 1,
  });

  await page.getByRole('button', { name: 'Save' }).click();

  await expect(page.getByRole('alert')).toContainText('changed since you opened it');
  await expect(blockBox(page)).toHaveValue(
    'Revenue is up twenty percent, and I typed this by hand.',
  );
});

test('clicking outside an open block neither saves nor discards', async ({ page }) => {
  const artifact = await server.publish({ type: 'markdown', content: REPORT });
  await openAsOwner(page, artifact.slug);
  await startEditing(page);

  await page.locator('article.prose p', { hasText: 'Revenue is up' }).click();
  await blockBox(page).fill('Half-written thought');

  await page.locator('body').click({ position: { x: 5, y: 5 } });

  await expect(blockBox(page)).toHaveValue('Half-written thought');
  await expect(page.locator('article.prose')).toContainText('eighteen percent');
});

test('Cmd+S saves the open block', async ({ page }) => {
  const artifact = await server.publish({ type: 'markdown', content: REPORT });
  await openAsOwner(page, artifact.slug);
  await startEditing(page);

  await page.locator('article.prose h1').click();
  await blockBox(page).fill('# Quarterly review, revised');
  await page.keyboard.press('ControlOrMeta+s');

  await expect(page.locator('article.prose h1')).toHaveText('Quarterly review, revised');
});

test('Escape with nothing open leaves edit mode', async ({ page }) => {
  const artifact = await server.publish({ type: 'markdown', content: REPORT });
  await openAsOwner(page, artifact.slug);
  await startEditing(page);

  await page.keyboard.press('Escape');

  await expect(page.locator('article.prose[data-oa-editing]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
});

test('source that belongs to no block is reachable through the full source', async ({ page }) => {
  // Footnote bodies and link reference definitions occupy source that no
  // rendered block covers, so block editing cannot reach them at all. The way
  // out is on screen the whole time rather than discovered after being stuck.
  const artifact = await server.publish({
    type: 'markdown',
    content: 'Text with a note[^1].\n\n[^1]: The body of the note.\n',
  });
  await openAsOwner(page, artifact.slug);
  await startEditing(page);

  await page.getByRole('button', { name: 'Source', exact: true }).click();

  const whole = page.getByLabel('Markdown source for the whole document');
  await expect(whole).toContainText('[^1]: The body of the note.');

  await whole.fill('Text with a note[^1].\n\n[^1]: A better body.\n');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('button', { name: 'Blocks', exact: true }).click();

  await expect(page.locator('article.prose')).toContainText('A better body.');
});

test('the whole-source box holds the document the first time it is opened', async ({ page }) => {
  // It used to fill only on the second visit, because filling it was done in an
  // effect. Effects run after paint and can run twice for the same inputs, so
  // the first open showed an empty box, and saving that would have emptied the
  // document.
  const artifact = await server.publish({ type: 'markdown', content: REPORT });
  await openAsOwner(page, artifact.slug);
  await startEditing(page);

  await page.getByRole('button', { name: 'Source', exact: true }).click();
  await expect(page.getByLabel('Markdown source for the whole document')).toHaveValue(REPORT);
});

test('opening whole source after a block still holds the whole document', async ({ page }) => {
  const artifact = await server.publish({ type: 'markdown', content: REPORT });
  await openAsOwner(page, artifact.slug);
  await startEditing(page);

  await page.locator('article.prose h1').click();
  await expect(blockBox(page)).toHaveValue('# Quarterly review');

  await page.getByRole('button', { name: 'Source', exact: true }).click();
  await expect(page.getByLabel('Markdown source for the whole document')).toHaveValue(REPORT);
});

test('typing in the whole source survives an unrelated re-render', async ({ page }) => {
  const artifact = await server.publish({ type: 'markdown', content: REPORT });
  await openAsOwner(page, artifact.slug);
  await startEditing(page);
  await page.getByRole('button', { name: 'Source', exact: true }).click();

  const whole = page.getByLabel('Markdown source for the whole document');
  await whole.fill('# Typed by hand\n');

  // Anything that re-renders the page around the editor used to refetch the
  // source and refill the box, throwing this away.
  await page.getByRole('button', { name: 'Comments' }).click();
  await page.getByRole('button', { name: 'Comments' }).click();

  await expect(whole).toHaveValue('# Typed by hand\n');
});

test('a block cannot leave its text in the whole-document box', async ({ page }) => {
  // This destroyed documents. One draft served both boxes, so after visiting
  // whole source, editing a block, and returning to whole source, the box held
  // the single paragraph. Saving replaced the entire document with it.
  const artifact = await server.publish({ type: 'markdown', content: REPORT });
  await openAsOwner(page, artifact.slug);
  await startEditing(page);

  await page.getByRole('button', { name: 'Source', exact: true }).click();
  await page.getByRole('button', { name: 'Blocks', exact: true }).click();
  await page.locator('article.prose p', { hasText: 'Revenue is up' }).click();
  await expect(blockBox(page)).toHaveValue('Revenue is up eighteen percent on the quarter.');

  await page.getByRole('button', { name: 'Source', exact: true }).click();
  await expect(page.getByLabel('Markdown source for the whole document')).toHaveValue(REPORT);
});

test('escape asks before discarding a typed document', async ({ page }) => {
  const artifact = await server.publish({ type: 'markdown', content: REPORT });
  await openAsOwner(page, artifact.slug);
  await startEditing(page);
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  await page.getByLabel('Markdown source for the whole document').fill('# Work worth keeping\n');

  let asked = false;
  page.on('dialog', (dialog) => {
    asked = true;
    void dialog.dismiss();
  });
  await page.keyboard.press('Escape');

  await expect.poll(() => asked).toBe(true);
  await expect(page.getByRole('button', { name: 'Done', exact: true })).toBeVisible();
  await expect(page.getByLabel('Markdown source for the whole document')).toHaveValue(
    '# Work worth keeping\n',
  );
});

test('done asks before discarding a typed document', async ({ page }) => {
  // Done lives in the bar, outside the editor, so it has to borrow the same
  // check rather than quietly turning editing off.
  const artifact = await server.publish({ type: 'markdown', content: REPORT });
  await openAsOwner(page, artifact.slug);
  await startEditing(page);
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  await page.getByLabel('Markdown source for the whole document').fill('# Also worth keeping\n');

  let asked = false;
  page.on('dialog', (dialog) => {
    asked = true;
    void dialog.dismiss();
  });
  await page.getByRole('button', { name: 'Done', exact: true }).click();

  await expect.poll(() => asked).toBe(true);
  await expect(page.getByLabel('Markdown source for the whole document')).toHaveValue(
    '# Also worth keeping\n',
  );
});

test('a link inside a block does not carry the owner off the page', async ({ page }) => {
  const artifact = await server.publish({
    type: 'markdown',
    content: '# Title\n\nSee [the docs](https://example.com/docs) for more.\n',
  });
  await openAsOwner(page, artifact.slug);
  await startEditing(page);

  await page.locator('article.prose a').click();

  await expect(page).toHaveURL(new RegExp(`/a/${artifact.slug}$`));
  await expect(blockBox(page)).toHaveValue('See [the docs](https://example.com/docs) for more.');
});

test('an empty document is editable, with no dead end', async ({ page }) => {
  const artifact = await server.publish({ type: 'markdown', content: '\n' });
  await openAsOwner(page, artifact.slug);
  await startEditing(page);

  // Nothing to click, but the way to change it is already visible.
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  await page.getByLabel('Markdown source for the whole document').fill('# It works now\n');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('button', { name: 'Blocks', exact: true }).click();

  await expect(page.locator('article.prose h1')).toHaveText('It works now');
});

test('a reader who does not own it sees no way to edit', async ({ page }) => {
  const artifact = await server.publish({ type: 'markdown', content: REPORT });
  const guest = await server.signInAs('guest@example.com');
  await server.as(`/api/artifacts/${artifact.id}/sharing/people`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'guest@example.com' }),
  });

  const separator = guest.indexOf('=');
  await page.context().addCookies([
    {
      name: guest.slice(0, separator),
      value: guest.slice(separator + 1),
      url: server.baseUrl,
    },
  ]);
  await page.goto(`${server.baseUrl}/a/${artifact.slug}`);

  await expect(page.locator('article.prose')).toContainText('Revenue is up');
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Source', exact: true })).toHaveCount(0);
});

test('commenting still works when edit mode is off', async ({ page }) => {
  // Editing and commenting want the same gesture, so editing takes the click
  // only while it is on. With it off, nothing about the page has changed.
  const artifact = await server.publish({ type: 'markdown', content: REPORT });
  await openAsOwner(page, artifact.slug);

  await page.evaluate(() => {
    const paragraph = document.querySelector('article.prose p');
    if (!paragraph?.firstChild) throw new Error('no paragraph');
    const range = document.createRange();
    range.setStart(paragraph.firstChild, 0);
    range.setEnd(paragraph.firstChild, 7);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await page.locator('article.prose').dispatchEvent('mouseup');

  await expect(page.getByRole('button', { name: 'Comment', exact: true })).toBeVisible();
});
