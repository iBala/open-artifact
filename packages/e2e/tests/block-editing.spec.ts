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

/**
 * The rich editor's writing surface for whichever block is open.
 *
 * Hidden until the editor has started, so waiting for it to be visible is also
 * how these tests wait for it to be ready.
 */
function richBox(page: Page) {
  return page.locator('.oa-rich .ProseMirror');
}

/**
 * The raw Markdown textarea for whichever block is open.
 *
 * Only some blocks get this now. A block holding something the rich editor
 * cannot represent — a footnote, raw HTML — falls back to it deliberately; see
 * richTextSafe in block-edit.ts.
 */
function blockBox(page: Page) {
  return page.getByLabel('Markdown source for this block');
}

/**
 * Replaces everything in the open rich block with `text`.
 *
 * Selecting the whole block and typing over it is a replacement, not an edit,
 * and the editor treats it as one: the old block is deleted and what replaces
 * it is a plain paragraph. That is fine for a paragraph and wrong for anything
 * else, so a heading or a table is edited with `append` instead — which is what
 * a person does anyway.
 */
async function retype(page: Page, text: string): Promise<void> {
  await richBox(page).click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type(text);
  // The editor reports changes to the page asynchronously, and everything that
  // depends on the block being dirty — Save, the guard on leaving — only turns
  // on once it has. Waiting for Save is waiting for that to have happened.
  await expect(page.getByRole('button', { name: 'Save' })).toBeVisible();
}

/** Types `text` at the end of the open rich block, leaving the block itself alone. */
async function append(page: Page, text: string): Promise<void> {
  await richBox(page).click();
  await page.keyboard.press('End');
  await page.keyboard.type(text);
  await expect(page.getByRole('button', { name: 'Save' })).toBeVisible();
}

test('an owner fixes a typo without leaving the page', async ({ page }) => {
  const artifact = await server.publish({ type: 'markdown', content: REPORT });
  await openAsOwner(page, artifact.slug);
  await startEditing(page);

  await page.locator('article.prose p', { hasText: 'Revenue is up' }).click();

  // The box holds the words as they read, not the Markdown that produced them.
  await expect(richBox(page)).toBeVisible();
  await expect(richBox(page)).toHaveText('Revenue is up eighteen percent on the quarter.');

  await retype(page, 'Revenue is up nineteen percent on the quarter.');
  await page.getByRole('button', { name: 'Save' }).click();

  await expect(page.locator('article.prose')).toContainText('nineteen percent');
  await expect(page.locator('article.prose')).not.toContainText('eighteen percent');

  // Edit mode stays on, so a run of small fixes does not mean turning it back on
  // between each one.
  await expect(page.locator('article.prose[data-oa-editing]')).toBeAttached();
});

test('a block keeps what it is through an edit', async ({ page }) => {
  /*
   * What the raw box guaranteed by showing `## Europe` — that editing a heading
   * cannot silently demote it to a paragraph — still has to hold now that the
   * marker is not on screen. It is just checked where it actually matters, on
   * the published page, rather than in the box.
   */
  const artifact = await server.publish({ type: 'markdown', content: REPORT });
  await openAsOwner(page, artifact.slug);
  await startEditing(page);

  await page.locator('article.prose h2').click();
  await expect(richBox(page)).toBeVisible();
  // The heading reads as a heading, without its Markdown marker.
  await expect(richBox(page)).toHaveText('Europe');

  await append(page, ' and the Nordics');
  await page.getByRole('button', { name: 'Save' }).click();

  // The editor is mounted inside the article, so wait for it to close before
  // asking the document anything: until then its own heading is in there too.
  await expect(page.locator('.oa-rich')).toHaveCount(0);

  // Still an h2, with the new words in it.
  await expect(page.locator('article.prose h2')).toHaveText('Europe and the Nordics');
});

test('a table is edited as a table, and stays one', async ({ page }) => {
  // The pipes and the alignment row were the thing nobody wanted to hand-write.
  const artifact = await server.publish({ type: 'markdown', content: REPORT });
  await openAsOwner(page, artifact.slug);
  await startEditing(page);

  await page.locator('article.prose table').click();
  await expect(richBox(page)).toBeVisible();

  // A real grid in the editor, not a block of pipe characters.
  await expect(richBox(page).locator('td').first()).toBeVisible();
  await expect(richBox(page)).toContainText('India');

  // Editing one cell, in place, without touching a pipe character.
  const cell = richBox(page).locator('td', { hasText: '31%' }).first();
  await cell.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' → 34%');
  await expect(page.getByRole('button', { name: 'Save' })).toBeVisible();
  await page.getByRole('button', { name: 'Save' }).click();

  await expect(page.locator('.oa-rich')).toHaveCount(0);
  await expect(page.locator('article.prose table')).toContainText('34%');
  await expect(page.locator('article.prose table')).toContainText('India');
  // Still a table on the page, not a paragraph of pipes.
  await expect(page.locator('article.prose table th')).toHaveCount(2);
});

test('clicking inside a block edits the block, not the bit that was clicked', async ({ page }) => {
  const artifact = await server.publish({
    type: 'markdown',
    content: '# Title\n\nA paragraph with **bold** inside it.\n',
  });
  await openAsOwner(page, artifact.slug);
  await startEditing(page);

  await page.locator('article.prose strong').click();
  await expect(richBox(page)).toBeVisible();
  await expect(richBox(page)).toHaveText('A paragraph with bold inside it.');
  // The whole paragraph opened, and the bold run is still bold inside it.
  await expect(richBox(page).locator('strong')).toHaveText('bold');
});

test('a conflicting save keeps the typed text', async ({ page }) => {
  // The failure this feature must never have. Somebody types, the document moves
  // under them, and the save is refused. Their words stay in the box.
  const artifact = await server.publish({ type: 'markdown', content: REPORT });
  await openAsOwner(page, artifact.slug);
  await startEditing(page);

  await page.locator('article.prose p', { hasText: 'Revenue is up' }).click();
  await expect(richBox(page)).toBeVisible();
  await retype(page, 'Revenue is up twenty percent, and I typed this by hand.');

  // An agent republishes while the box is open.
  await server.update({
    id: artifact.id,
    content: REPORT.replace('Europe was flat', 'Europe grew slightly'),
    baseVersion: 1,
  });

  await page.getByRole('button', { name: 'Save' }).click();

  await expect(page.getByRole('alert')).toContainText('changed since you opened it');
  await expect(richBox(page)).toHaveText('Revenue is up twenty percent, and I typed this by hand.');
});

test('clicking outside an open block neither saves nor discards', async ({ page }) => {
  const artifact = await server.publish({ type: 'markdown', content: REPORT });
  await openAsOwner(page, artifact.slug);
  await startEditing(page);

  await page.locator('article.prose p', { hasText: 'Revenue is up' }).click();
  await expect(richBox(page)).toBeVisible();
  await retype(page, 'Half-written thought');

  await page.locator('body').click({ position: { x: 5, y: 5 } });

  await expect(richBox(page)).toHaveText('Half-written thought');
  await expect(page.locator('article.prose')).toContainText('eighteen percent');
});

test('Cmd+S saves the open block', async ({ page }) => {
  const artifact = await server.publish({ type: 'markdown', content: REPORT });
  await openAsOwner(page, artifact.slug);
  await startEditing(page);

  await page.locator('article.prose h1').click();
  await expect(richBox(page)).toBeVisible();
  // No `#` to type: it is already a heading and stays one.
  await append(page, ', revised');
  await page.keyboard.press('ControlOrMeta+s');

  await expect(page.locator('.oa-rich')).toHaveCount(0);
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
  await expect(richBox(page)).toBeVisible();
  await expect(richBox(page)).toHaveText('Quarterly review');

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
  await expect(richBox(page)).toBeVisible();
  await expect(richBox(page)).toHaveText('Revenue is up eighteen percent on the quarter.');

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

test('leaving still asks after switching away from the source view', async ({ page }) => {
  // Unsaved work does not stop being unsaved because the box holding it is off
  // screen. The check used to look only while whole-source was showing, so
  // typing a document, switching to blocks and pressing Done threw it away.
  const artifact = await server.publish({ type: 'markdown', content: REPORT });
  await openAsOwner(page, artifact.slug);
  await startEditing(page);

  await page.getByRole('button', { name: 'Source', exact: true }).click();
  await page.getByLabel('Markdown source for the whole document').fill('# Typed then hidden\n');
  await page.getByRole('button', { name: 'Blocks', exact: true }).click();

  let asked = false;
  page.on('dialog', (dialog) => {
    asked = true;
    void dialog.dismiss();
  });
  await page.getByRole('button', { name: 'Done', exact: true }).click();

  await expect.poll(() => asked).toBe(true);
  await expect(page.getByRole('button', { name: 'Done', exact: true })).toBeVisible();
});

test('done asks before discarding an open block', async ({ page }) => {
  // Escape asked, because it went through the block's own dismissal. Done did
  // not, because it only ever consulted the whole-document draft.
  const artifact = await server.publish({ type: 'markdown', content: REPORT });
  await openAsOwner(page, artifact.slug);
  await startEditing(page);

  await page.locator('article.prose p', { hasText: 'Revenue is up' }).click();
  await expect(richBox(page)).toBeVisible();
  await retype(page, 'Half-written thought');

  let asked = false;
  page.on('dialog', (dialog) => {
    asked = true;
    void dialog.dismiss();
  });
  await page.getByRole('button', { name: 'Done', exact: true }).click();

  await expect.poll(() => asked).toBe(true);
  await expect(richBox(page)).toHaveText('Half-written thought');
});

test('leaving with nothing typed does not nag', async ({ page }) => {
  // The other side of the guard. Asking when there is nothing to lose trains
  // people to dismiss the question without reading it.
  const artifact = await server.publish({ type: 'markdown', content: REPORT });
  await openAsOwner(page, artifact.slug);
  await startEditing(page);
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  await expect(page.getByLabel('Markdown source for the whole document')).toHaveValue(REPORT);

  let asked = false;
  page.on('dialog', (dialog) => {
    asked = true;
    void dialog.dismiss();
  });
  await page.getByRole('button', { name: 'Done', exact: true }).click();

  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
  expect(asked).toBe(false);
});

test('a discarded block is put back on the page', async ({ page }) => {
  const artifact = await server.publish({ type: 'markdown', content: REPORT });
  await openAsOwner(page, artifact.slug);
  await startEditing(page);

  await page.locator('article.prose p', { hasText: 'Revenue is up' }).click();
  await expect(richBox(page)).toBeVisible();
  await retype(page, 'Discard me');

  page.on('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Done', exact: true }).click();

  // The paragraph was hidden while its box was open. Leaving must not leave it
  // hidden, and must not have saved the abandoned text either.
  await expect(page.locator('article.prose')).toContainText(
    'Revenue is up eighteen percent on the quarter.',
  );
  await expect(page.locator('article.prose')).not.toContainText('Discard me');
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
  await expect(richBox(page)).toBeVisible();
  await expect(richBox(page)).toHaveText('See the docs for more.');
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

test('a block the rich editor cannot represent falls back to Markdown', async ({ page }) => {
  /*
   * The rich editor holds a block as a ProseMirror document, and anything its
   * schema cannot model does not come back out. A footnote reference would be
   * deleted by the round trip, and the save that followed would look entirely
   * normal, so blocks like this one are never handed to it in the first place.
   */
  const artifact = await server.publish({
    type: 'markdown',
    content: 'A claim worth supporting.[^1]\n\nA plain paragraph.\n\n[^1]: The note.\n',
  });
  await openAsOwner(page, artifact.slug);
  await startEditing(page);

  await page.locator('article.prose p', { hasText: 'A claim worth supporting' }).click();

  // The raw box, with the footnote marker intact and nothing pretending to
  // render it.
  await expect(blockBox(page)).toHaveValue('A claim worth supporting.[^1]');
  await expect(page.locator('.oa-rich')).toHaveCount(0);

  // And the paragraph beside it, which holds nothing unusual, still gets the
  // rich editor. The fallback is per block, not per document.
  await page.keyboard.press('Escape');
  await page.locator('article.prose p', { hasText: 'A plain paragraph' }).click();
  await expect(richBox(page)).toBeVisible();
});

test('the slash menu offers the blocks nobody remembers the syntax for', async ({ page }) => {
  // The whole point of the exercise: turning a paragraph into something else
  // without knowing what Markdown calls it.
  const artifact = await server.publish({
    type: 'markdown',
    content: '# Title\n\nA paragraph to promote.\n',
  });
  await openAsOwner(page, artifact.slug);
  await startEditing(page);

  await page.locator('article.prose p', { hasText: 'A paragraph to promote' }).click();
  await expect(richBox(page)).toBeVisible();

  await richBox(page).click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('/');

  const menu = page.locator('.milkdown-slash-menu');
  await expect(menu).toBeVisible();
  await expect(menu).toContainText('Bullet List');

  // Math is deliberately absent: the server renders no maths, so offering it
  // would invite somebody to write what their readers cannot see.
  await expect(menu).not.toContainText('Math');
});

test('saving a block leaves the reader where they were', async ({ page }) => {
  /*
   * Reloading the page after a save used to blank the document first, which
   * unmounted the article, collapsed the scroll container to zero, and put
   * somebody who had just fixed a word near the end back at the title.
   */
  const body = Array.from({ length: 60 }, (_, i) => `Paragraph number ${i + 1}.`).join('\n\n');
  const artifact = await server.publish({
    type: 'markdown',
    content: `# A long document\n\n${body}\n`,
  });
  await openAsOwner(page, artifact.slug);
  await startEditing(page);

  const target = page.locator('article.prose p', { hasText: 'Paragraph number 55.' });
  await target.scrollIntoViewIfNeeded();
  await target.click();
  await expect(richBox(page)).toBeVisible();

  // The comments panel scrolls as well, so this is specifically the one the
  // document sits in.
  const scroller = page.locator('.oa-scroll', { has: page.locator('article.prose') });
  const before = await scroller.evaluate((element) => element.scrollTop);
  expect(before).toBeGreaterThan(0);

  await retype(page, 'Paragraph number 55, corrected.');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('article.prose')).toContainText('Paragraph number 55, corrected.');

  // Back within a screen of where they were, rather than at the top.
  const after = await scroller.evaluate((element) => element.scrollTop);
  expect(Math.abs(after - before)).toBeLessThan(400);
});

test('a reference link keeps its definition rather than being escaped', async ({ page }) => {
  /*
   * The block reads as ordinary prose, which is what makes it dangerous. Parsed
   * on its own the reference has no definition to bind to, so the rich editor
   * would read it as text and write it back with the brackets escaped, killing
   * the link in a save that looked entirely normal.
   */
  const artifact = await server.publish({
    type: 'markdown',
    content: 'See [the spec][spec] for more.\n\n[spec]: https://example.com/spec\n',
  });
  await openAsOwner(page, artifact.slug);
  await startEditing(page);

  await page.locator('article.prose p', { hasText: 'See the spec' }).click();

  // The raw box, with the reference intact.
  await expect(blockBox(page)).toHaveValue('See [the spec][spec] for more.');
  await expect(page.locator('.oa-rich')).toHaveCount(0);

  await blockBox(page).fill('See [the spec][spec] for much more.');
  await page.getByRole('button', { name: 'Save' }).click();

  // Still a link, still pointing where it pointed.
  await expect(page.locator('article.prose a')).toHaveAttribute(
    'href',
    'https://example.com/spec',
  );
});

test('a rich block that was not edited is never rewritten', async ({ page }) => {
  /*
   * The editor re-serialises whatever it parsed, so an untouched block is
   * already a different string from the source it came from. Without a guard a
   * reflexive Cmd+S published the editor's version of the author's Markdown —
   * a new version, with nothing visibly different about it.
   */
  const artifact = await server.publish({
    type: 'markdown',
    content: '# Title\n\n* one\n* two\n\nA closing line.\n',
  });
  await openAsOwner(page, artifact.slug);
  await startEditing(page);

  await page.locator('article.prose ul').click();
  await expect(richBox(page)).toBeVisible();

  await page.keyboard.press('ControlOrMeta+s');
  await page.waitForTimeout(500);

  // Nothing was written, so the bullets are still the author's asterisks.
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  await expect(page.getByLabel('Markdown source for the whole document')).toHaveValue(
    '# Title\n\n* one\n* two\n\nA closing line.\n',
  );
});

test('escape closes the slash menu without discarding the block', async ({ page }) => {
  // Crepe closes its own menu on Escape but lets the key carry on bubbling, so
  // one press used to close the menu and throw the block away behind it.
  const artifact = await server.publish({
    type: 'markdown',
    content: '# Title\n\nA paragraph to keep.\n',
  });
  await openAsOwner(page, artifact.slug);
  await startEditing(page);

  await page.locator('article.prose p', { hasText: 'A paragraph to keep' }).click();
  await expect(richBox(page)).toBeVisible();

  // The menu opens on a slash at the start of a line, so the block is cleared
  // first. That also leaves it dirty, which is the point: if Escape reached the
  // block it would ask whether to discard, and that question is the bug.
  await richBox(page).click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('/');
  await expect(page.locator('.milkdown-slash-menu')).toBeVisible();

  let asked = false;
  page.on('dialog', (dialog) => {
    asked = true;
    void dialog.dismiss();
  });
  await page.keyboard.press('Escape');

  // Menu gone, block still open, and nothing was asked about discarding it.
  await expect(page.locator('.milkdown-slash-menu')).toBeHidden();
  await expect(richBox(page)).toBeVisible();
  expect(asked).toBe(false);

  // And a second Escape, with no menu open, does reach the block. Waiting for
  // Save first is waiting for the editor to have reported the typing: until it
  // has, the block is not yet dirty and there would be nothing to ask about.
  await expect(page.getByRole('button', { name: 'Save' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect.poll(() => asked).toBe(true);
});

test('an untouched rich block offers nothing to save', async ({ page }) => {
  // The editor appends a trailing empty paragraph just after it starts, which
  // used to read as an edit: Save appeared on a block nobody had touched.
  const artifact = await server.publish({ type: 'markdown', content: REPORT });
  await openAsOwner(page, artifact.slug);
  await startEditing(page);

  await page.locator('article.prose p', { hasText: 'Revenue is up' }).click();
  await expect(richBox(page)).toBeVisible();
  await expect(richBox(page)).toHaveText('Revenue is up eighteen percent on the quarter.');

  await expect(page.getByRole('button', { name: 'Save' })).toHaveCount(0);
});
