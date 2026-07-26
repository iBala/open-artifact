import { test, expect, type Page } from '@playwright/test';
import { startServer, type RunningServer } from '../src/server.js';

/**
 * Light and dark, in a real browser.
 *
 * Three things about a theme switcher can only be checked here. That the page is
 * already the right colour on the very first paint — the part people notice when
 * it is wrong. That the choice survives a reload. And that "follow my system"
 * really does follow, live, without a reload.
 */

let server: RunningServer;

test.beforeEach(async () => {
  server = await startServer();
});

test.afterEach(async () => {
  await server.stop();
});

/** What the stylesheet is keying off right now. */
const themeOf = (page: Page) =>
  page.evaluate(() => document.documentElement.dataset.theme);

test('a dark system gets a dark app, and a light one gets light', async ({ browser }) => {
  const dark = await browser.newContext({ colorScheme: 'dark' });
  const darkPage = await dark.newPage();
  await server.signInBrowser(dark);
  await darkPage.goto(server.baseUrl);
  await expect(darkPage.getByRole('heading', { name: 'Artifacts' })).toBeVisible();
  expect(await themeOf(darkPage)).toBe('dark');
  await dark.close();

  const light = await browser.newContext({ colorScheme: 'light' });
  const lightPage = await light.newPage();
  await server.signInBrowser(light);
  await lightPage.goto(server.baseUrl);
  await expect(lightPage.getByRole('heading', { name: 'Artifacts' })).toBeVisible();
  expect(await themeOf(lightPage)).toBe('light');
  await light.close();
});

test('choosing a theme holds across a reload, and beats the system setting', async ({ browser }) => {
  // A light machine, so choosing dark is visibly a choice and not the default.
  const context = await browser.newContext({ colorScheme: 'light' });
  const page = await context.newPage();
  await server.signInBrowser(context);
  await page.goto(server.baseUrl);

  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('radio', { name: 'Dark' }).click();
  expect(await themeOf(page)).toBe('dark');

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Artifacts' })).toBeVisible();
  expect(await themeOf(page)).toBe('dark');

  await context.close();
});

test('the page is already dark before the app has loaded at all', async ({ browser }) => {
  // The no-flash guarantee, and the only test that can catch losing it. With the
  // app bundle blocked, nothing but the inline script in index.html can have set
  // the theme — so if that snippet were dropped, this is the test that fails.
  // Without it the app still ends up dark, just after a white frame, which every
  // other test here would happily pass through.
  const context = await browser.newContext({ colorScheme: 'light' });
  const page = await context.newPage();
  await context.addInitScript(() => localStorage.setItem('oa.theme', 'dark'));
  await page.route('**/assets/*.js', (route) => route.abort());

  await page.goto(server.baseUrl);
  expect(await themeOf(page)).toBe('dark');
  // And the colour actually landed, not just the attribute.
  const canvas = await page.evaluate(() =>
    getComputedStyle(document.documentElement).backgroundColor,
  );
  expect(canvas).not.toBe('rgb(255, 255, 255)');

  await context.close();
});

test('going back to "match system" starts following the system again', async ({ browser }) => {
  const context = await browser.newContext({ colorScheme: 'light' });
  const page = await context.newPage();
  await server.signInBrowser(context);
  await page.goto(server.baseUrl);

  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('radio', { name: 'Dark' }).click();
  expect(await themeOf(page)).toBe('dark');

  await page.getByRole('radio', { name: 'Match system' }).click();
  expect(await themeOf(page)).toBe('light');

  // The system flips under it. No reload: somebody whose machine turns dark at
  // sunset should not have to refresh the tab they left open.
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(() => themeOf(page)).toBe('dark');

  await context.close();
});

test('a reader with no account can change the theme from the artifact bar', async ({ browser }) => {
  const published = await server.publish({
    type: 'markdown',
    content: '# Night reading\n\nA paragraph to look at.',
    title: 'Night reading',
  });
  await server.as(`/api/artifacts/${published.id}/sharing/public`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ isPublic: true }),
  });

  // No session cookie: this is a stranger following a link.
  const context = await browser.newContext({ colorScheme: 'light' });
  const page = await context.newPage();
  await page.goto(`${server.baseUrl}/a/${published.slug}`);

  await expect(page.getByRole('banner').getByRole('heading', { name: 'Night reading' })).toBeVisible();
  expect(await themeOf(page)).toBe('light');

  await page.getByRole('radio', { name: 'Dark' }).click();
  expect(await themeOf(page)).toBe('dark');

  await page.reload();
  await expect(page.getByRole('banner').getByRole('heading', { name: 'Night reading' })).toBeVisible();
  expect(await themeOf(page)).toBe('dark');

  await context.close();
});
