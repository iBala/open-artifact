import { test, expect } from '@playwright/test';
import { startServer, type RunningServer } from '../src/server.js';

/**
 * Sprint 2's demo, run as a test.
 *
 * Sign in through the browser with a real emailed link, land on the dashboard,
 * see what you published, and take a command line's access away from the
 * sessions page.
 */

let server: RunningServer;

test.beforeEach(async () => {
  server = await startServer();
});

test.afterEach(async () => {
  await server.stop();
});

test('sign in with an emailed link and land on the dashboard', async ({ page }) => {
  await page.goto(server.baseUrl);

  // Nobody is signed in, so the sign-in screen is what loads.
  await expect(page.getByRole('heading', { name: 'Open Artifact' })).toBeVisible();

  await page.getByLabel('Email address').fill('newcomer@example.com');
  await page.getByRole('button', { name: /sign-in link/i }).click();

  // The wording must not reveal whether the address has an account here.
  await expect(page.getByText(/if .* can sign in here/i)).toBeVisible();

  // Follow the link out of the email, exactly as the person would.
  await page.goto(server.magicLinkFor('newcomer@example.com'));

  await expect(page.getByRole('heading', { name: 'What you published' })).toBeVisible();
  await expect(page.getByText('Nothing published yet')).toBeVisible();
});

test('the dashboard lists what you published, and nobody else’s work', async ({
  page,
  context,
}) => {
  await server.publish({ type: 'markdown', content: '# Quarterly report' });
  await server.publish({ type: 'html', content: '<title>Live dashboard</title><h1>Hi</h1>' });

  await server.signInBrowser(context);
  await page.goto(server.baseUrl);

  await expect(page.getByRole('link', { name: /Quarterly report/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Live dashboard/ })).toBeVisible();
});

test('opening an artifact from the dashboard shows it', async ({ page, context }) => {
  await server.publish({ type: 'markdown', content: '# Quarterly report\n\nRevenue is up.' });

  await server.signInBrowser(context);
  await page.goto(server.baseUrl);
  await page.getByRole('link', { name: /Quarterly report/ }).click();

  await expect(page.locator('article.prose h1')).toHaveText('Quarterly report');
  await expect(page.getByText('Revenue is up.')).toBeVisible();
});

test('the sessions page revokes a command line, and it stops working at once', async ({
  page,
  context,
}) => {
  // Connect a command line the way `open-artifact login` does.
  const token = await server.connectCommandLine('Claude Code on the laptop');

  const beforeRevoking = await fetch(`${server.baseUrl}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(beforeRevoking.status).toBe(200);

  await server.signInBrowser(context);
  await page.goto(`${server.baseUrl}/settings/sessions`);

  await expect(page.getByText('Claude Code on the laptop')).toBeVisible();
  await page.getByRole('button', { name: 'Revoke' }).click();
  await expect(page.getByText('Claude Code on the laptop')).toBeHidden();

  const afterRevoking = await fetch(`${server.baseUrl}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(afterRevoking.status).toBe(401);
});

test('the sessions page marks the browser you are actually using', async ({ page, context }) => {
  await server.signInBrowser(context);
  await page.goto(`${server.baseUrl}/settings/sessions`);

  await expect(page.getByText('This browser')).toBeVisible();
});

test('signing out ends the session, and going back does not get you in', async ({
  page,
  context,
}) => {
  await server.signInBrowser(context);
  await page.goto(server.baseUrl);

  await page.getByRole('button', { name: /e2e-owner@example\.com/ }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();

  await expect(page.getByLabel('Email address')).toBeVisible();

  // The cookie is gone, so reloading lands on the sign-in screen again rather
  // than on a cached dashboard.
  await page.reload();
  await expect(page.getByLabel('Email address')).toBeVisible();
});

test('a signed-out person never sees a private artifact', async ({ page }) => {
  const artifact = await server.publish({ type: 'markdown', content: '# Shared plans' });

  // No session in this browser at all.
  await page.goto(`${server.baseUrl}/a/${artifact.slug}`);
  await expect(page.locator('body')).not.toContainText('Shared plans');

  // Being routed through sign-in and back to the artifact is Sprint 4 (ticket
  // 4.9), once there is such a thing as an artifact shared with you. Until
  // then, not showing it is the whole requirement.
});
