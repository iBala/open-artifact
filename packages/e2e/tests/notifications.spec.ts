import { test, expect, type Browser, type Page } from '@playwright/test';
import { startServer, type RunningServer } from '../src/server.js';

/**
 * Mentions and the bell, in a browser.
 *
 * The behaviour worth proving here is the one that is easy to get wrong: naming
 * somebody who cannot see the artifact must ask the owner rather than tell that
 * person, and the telling must happen the moment they are let in.
 */

const DOCUMENT = `# Quarterly report

Revenue is up eighteen percent on the quarter.
`;

let server: RunningServer;

test.beforeEach(async () => {
  server = await startServer();
});

test.afterEach(async () => {
  await server.stop();
});

/** Signs a second person in, in their own browser context. */
async function browserFor(browser: Browser, email: string): Promise<Page> {
  const cookie = await server.signInAs(email);
  const context = await browser.newContext();
  await context.addCookies([
    { name: 'oa_session', value: cookie.split('=').slice(1).join('='), url: server.baseUrl },
  ]);
  return context.newPage();
}

test('being shared something shows up on the bell', async ({ browser }) => {
  const artifact = await server.publish({ type: 'markdown', content: DOCUMENT });
  const colleague = await browserFor(browser, 'colleague@example.com');

  await server.as(`/api/artifacts/${artifact.id}/sharing/people`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'colleague@example.com' }),
  });

  await colleague.goto(server.baseUrl);
  await expect(colleague.getByRole('button', { name: /Notifications, 1 unread/ })).toBeVisible();

  await colleague.getByRole('button', { name: /Notifications/ }).click();
  await expect(colleague.getByText(/shared/)).toBeVisible();
});

test('naming somebody in a comment tells them', async ({ page, context, browser }) => {
  const artifact = await server.publish({ type: 'markdown', content: DOCUMENT });
  await server.signInAs('colleague@example.com');
  await server.as(`/api/artifacts/${artifact.id}/sharing/people`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'colleague@example.com' }),
  });

  await server.signInBrowser(context);
  await page.goto(`${server.baseUrl}/a/${artifact.slug}`);

  await page.getByRole('button', { name: 'Comment on the whole document' }).click();
  const composer = page.getByPlaceholder('A note about the whole document');
  await composer.fill('Please look at this ');

  // Typing @ offers the people who can be named here.
  await composer.type('@coll');
  await expect(page.getByText('colleague@example.com').first()).toBeVisible();
  await composer.press('Enter');

  await page.getByRole('button', { name: 'Send' }).click();

  const colleague = await browserFor(browser, 'colleague@example.com');
  await colleague.goto(server.baseUrl);
  await colleague.getByRole('button', { name: /Notifications/ }).click();
  await expect(colleague.getByText(/mentioned you/)).toBeVisible();
});

test('the mention box never lists everybody on the instance', async ({ page, context }) => {
  // A stranger with an account must not appear just because they exist.
  await server.signInAs('stranger@elsewhere.test');

  const artifact = await server.publish({ type: 'markdown', content: DOCUMENT });
  await server.signInBrowser(context);
  await page.goto(`${server.baseUrl}/a/${artifact.slug}`);

  await page.getByRole('button', { name: 'Comment on the whole document' }).click();
  await page.getByPlaceholder('A note about the whole document').type('@');

  await expect(page.getByText('stranger@elsewhere.test')).toBeHidden();
});

test('naming an outsider asks the owner, and tells them only once granted', async ({
  page,
  context,
  browser,
}) => {
  const artifact = await server.publish({ type: 'markdown', content: DOCUMENT });
  await server.as(`/api/artifacts/${artifact.id}/sharing/people`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'colleague@example.com' }),
  });

  // Both exist as accounts; only the colleague can see this artifact.
  await server.signInAs('outsider@elsewhere.test');
  const colleagueCookie = await server.signInAs('colleague@example.com');
  await fetch(`${server.baseUrl}/api/artifacts/${artifact.id}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: colleagueCookie },
    body: JSON.stringify({ body: 'We need @outsider@elsewhere.test on this' }),
  });

  // The outsider is told nothing: pointing at a document they cannot open would
  // be worse than saying nothing.
  const outsider = await browserFor(browser, 'outsider@elsewhere.test');
  await outsider.goto(server.baseUrl);
  await outsider.getByRole('button', { name: /Notifications/ }).click();

  // Scoped to the panel: the sidebar's "shared with you" empty state uses the
  // same words.
  const panel = outsider.getByRole('heading', { name: 'Notifications' }).locator('..').locator('..');
  await expect(panel.getByText('Nothing yet')).toBeVisible();

  // The owner is asked instead, and can answer in one press.
  await server.signInBrowser(context);
  await page.goto(server.baseUrl);
  await page.getByRole('button', { name: /Notifications/ }).click();
  await expect(page.getByText(/Add.*outsider@elsewhere\.test/)).toBeVisible();
  await page.getByRole('button', { name: 'Add them' }).click();

  // Now it is worth telling them, because now they can open it.
  await outsider.reload();
  await outsider.getByRole('button', { name: /Notifications/ }).click();
  await expect(outsider.getByText(/mentioned you/)).toBeVisible();
});

test('marking notifications read clears the count', async ({ browser }) => {
  const artifact = await server.publish({ type: 'markdown', content: DOCUMENT });
  await server.signInAs('colleague@example.com');
  await server.as(`/api/artifacts/${artifact.id}/sharing/people`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'colleague@example.com' }),
  });

  const colleague = await browserFor(browser, 'colleague@example.com');
  await colleague.goto(server.baseUrl);
  await expect(colleague.getByRole('button', { name: /1 unread/ })).toBeVisible();

  await colleague.getByRole('button', { name: /Notifications/ }).click();
  await colleague.getByRole('button', { name: 'Mark all read' }).click();

  await expect(colleague.getByRole('button', { name: /unread/ })).toBeHidden();
});

test('closing an account asks you to type your address, and then really closes it', async ({
  page,
  context,
}) => {
  const artifact = await server.publish({ type: 'markdown', content: DOCUMENT });

  await server.signInBrowser(context);
  await page.goto(`${server.baseUrl}/settings/sessions`);

  // The wording says what actually happens, rather than "your data is deleted",
  // which is not true and is not what somebody deciding deserves to read.
  await expect(page.getByText(/stay where they are, with your name removed/)).toBeVisible();

  await page.getByRole('button', { name: 'Close account' }).click();

  // Typing the address is more friction than a checkbox, on purpose: this is
  // the one action with nothing behind it.
  const confirm = page.getByRole('button', { name: 'Close it' });
  await expect(confirm).toBeDisabled();

  await page.getByLabel('Type your email address to confirm').fill('e2e-owner@example.com');
  await expect(confirm).toBeEnabled();
  await confirm.click();

  await expect(page.getByLabel('Email address')).toBeVisible();

  // And it is gone, not merely signed out.
  expect((await fetch(`${server.baseUrl}/api/artifacts/by-slug/${artifact.slug}`)).status).toBe(404);
});

test('the owner tagging a new address shares the document in one step', async ({
  page,
  context,
  browser,
}) => {
  const artifact = await server.publish({ type: 'markdown', content: DOCUMENT });
  await server.signInAs('priya@elsewhere.test');

  await server.signInBrowser(context);
  await page.goto(`${server.baseUrl}/a/${artifact.slug}`);

  await page.getByRole('button', { name: 'Comment on the whole document' }).click();
  const composer = page.getByPlaceholder('A note about the whole document');
  await composer.fill('Bringing you in ');

  // A full address that matches nobody becomes an offer, and the offer says
  // what it does: the owner shares by tagging.
  await composer.type('@priya@elsewhere.test');
  await expect(page.getByText('Tag priya@elsewhere.test')).toBeVisible();
  await expect(page.getByText('Shares this document with them')).toBeVisible();
  await composer.press('Enter');

  await page.getByRole('button', { name: 'Send' }).click();

  // Saying what happened is the fix: tagging used to be silent.
  await expect(page.getByText('Shared with priya@elsewhere.test and let them know.')).toBeVisible();

  // And it really happened: the document is on their bell and readable.
  const priya = await browserFor(browser, 'priya@elsewhere.test');
  await priya.goto(`${server.baseUrl}/a/${artifact.slug}`);
  // The title also sits in the top bar, so target the document body itself:
  // matching the heading by role would resolve to both and race on which
  // renders first.
  await expect(priya.locator('article.prose h1')).toHaveText('Quarterly report');
});
