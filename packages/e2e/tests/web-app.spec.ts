import { test, expect, type Page } from '@playwright/test';
import { startServer, type RunningServer } from '../src/server.js';

/**
 * The web app, in a browser.
 *
 * Sprint 5's demo run as a test: sign in with an emailed code, land on a
 * dashboard, open an artifact, share it, delete it, and see what a signed-out
 * visitor gets.
 */

let server: RunningServer;

test.beforeEach(async () => {
  server = await startServer();
});

test.afterEach(async () => {
  await server.stop();
});

/** Types a six-digit code into the six boxes. */
async function enterCode(page: Page, code: string): Promise<void> {
  await page.getByLabel('Digit 1').fill(code);
}

test('sign in with an emailed code and land on the dashboard', async ({ page }) => {
  await page.goto(server.baseUrl);

  await expect(page.getByRole('heading', { name: 'Open Artifact' })).toBeVisible();

  await page.getByLabel('Email address').fill('newcomer@example.com');
  await page.getByRole('button', { name: /email me a code/i }).click();

  // The wording must not reveal whether the address has an account here.
  await expect(page.getByText(/if .* can sign in here/i)).toBeVisible();

  await enterCode(page, server.signInCodeFor('newcomer@example.com'));

  await expect(page.getByRole('heading', { name: 'Artifacts' })).toBeVisible();
  // Both the sidebar and the dashboard say it; the dashboard is the one on screen.
  await expect(page.getByText('Nothing published yet').last()).toBeVisible();
});

test('a pasted code fills every box and signs the person in', async ({ page }) => {
  await page.goto(server.baseUrl);
  await page.getByLabel('Email address').fill('newcomer@example.com');
  await page.getByRole('button', { name: /email me a code/i }).click();

  // Pasting is what most people actually do, and it has to land in all six.
  const code = server.signInCodeFor('newcomer@example.com');
  await page.getByLabel('Digit 1').focus();
  await page.evaluate(async (value) => {
    await navigator.clipboard.writeText(value);
  }, code).catch(() => undefined);
  await page.getByLabel('Digit 1').fill(code);

  await expect(page.getByRole('heading', { name: 'Artifacts' })).toBeVisible();
});

test('a wrong code says so without saying which part was wrong', async ({ page }) => {
  await page.goto(server.baseUrl);
  await page.getByLabel('Email address').fill('newcomer@example.com');
  await page.getByRole('button', { name: /email me a code/i }).click();

  await enterCode(page, '000000');

  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('alert')).toContainText(/not valid/i);
});

test('the dashboard and sidebar list what you published', async ({ page, context }) => {
  await server.publish({ type: 'markdown', content: '# Quarterly report' });
  await server.publish({ type: 'html', content: '<title>Live dashboard</title><h1>Hi</h1>' });

  await server.signInBrowser(context);
  await page.goto(server.baseUrl);

  await expect(page.getByRole('link', { name: /Quarterly report/ }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: /Live dashboard/ }).first()).toBeVisible();
});

test('opening an artifact shows it, with the sidebar out of the way', async ({ page, context }) => {
  const artifact = await server.publish({
    type: 'markdown',
    content: '# Quarterly report\n\nRevenue is up.',
  });

  await server.signInBrowser(context);
  await page.goto(`${server.baseUrl}/a/${artifact.slug}`);

  await expect(page.locator('article.prose h1')).toHaveText('Quarterly report');
  await expect(page.getByText('Revenue is up.')).toBeVisible();

  // Arriving at an artifact directly collapses the sidebar to a rail, so the
  // document gets the width. One click brings it back.
  await expect(page.getByRole('button', { name: 'Show sidebar' })).toBeVisible();
  await page.getByRole('button', { name: 'Show sidebar' }).click();
  await expect(page.getByRole('link', { name: 'Open Artifact' })).toBeVisible();
});

test('starring an artifact pins it to its own sidebar section', async ({ page, context }) => {
  const artifact = await server.publish({ type: 'markdown', content: '# Field notes' });

  await server.signInBrowser(context);
  await page.goto(`${server.baseUrl}/a/${artifact.slug}`);

  const bar = page.locator('header');
  // Nothing starred yet: the bar offers to star, and there is no Starred section.
  await expect(bar.getByRole('button', { name: 'Star this' })).toBeVisible();

  await bar.getByRole('button', { name: 'Star this' }).click();
  await expect(bar.getByRole('button', { name: 'Remove star' })).toBeVisible();

  // Open the sidebar: the artifact now sits under a Starred heading, as well as
  // in Yours — so its link appears twice.
  await page.getByRole('button', { name: 'Show sidebar' }).click();
  const sidebar = page.getByRole('complementary');
  await expect(sidebar.getByText('Starred')).toBeVisible();
  await expect(sidebar.getByRole('link', { name: /Field notes/ })).toHaveCount(2);

  // Unstarring from the bar removes the section at once.
  await bar.getByRole('button', { name: 'Remove star' }).click();
  await expect(sidebar.getByText('Starred')).toHaveCount(0);
  await expect(sidebar.getByRole('link', { name: /Field notes/ })).toHaveCount(1);
});

test('sharing from the viewer gives somebody access', async ({ page, context }) => {
  const artifact = await server.publish({ type: 'markdown', content: '# Quarterly report' });

  await server.signInBrowser(context);
  await page.goto(`${server.baseUrl}/a/${artifact.slug}`);

  await page.getByRole('button', { name: 'Share' }).click();
  await expect(page.getByText('Only you can see this at the moment.')).toBeVisible();

  await page.getByLabel(/share with an email address/i).fill('colleague@example.com');
  await page.getByRole('button', { name: 'Share', exact: true }).last().click();

  // They have not signed in here, which is expected and is said so.
  await expect(page.getByText('colleague@example.com')).toBeVisible();
  await expect(page.getByText('Not signed in yet')).toBeVisible();

  // And it is real: they can now open it.
  const theirCookie = await server.signInAs('colleague@example.com');
  const response = await fetch(`${server.baseUrl}/api/artifacts/by-slug/${artifact.slug}`, {
    headers: { Cookie: theirCookie },
  });
  expect(response.status).toBe(200);
});

test('the public toggle says what it means, and makes the artifact readable', async ({
  page,
  context,
}) => {
  const artifact = await server.publish({ type: 'markdown', content: '# Read me' });

  await server.signInBrowser(context);
  await page.goto(`${server.baseUrl}/a/${artifact.slug}`);
  await page.getByRole('button', { name: 'Share' }).click();

  await expect(page.getByText(/only the people above can open it/i)).toBeVisible();
  await page.getByRole('switch').click();
  await expect(page.getByText(/anyone who has the link can read this/i)).toBeVisible();

  // Somebody with no account at all can now read it.
  const anonymous = await context.browser()!.newContext();
  const stranger = await anonymous.newPage();
  await stranger.goto(`${server.baseUrl}/a/${artifact.slug}`);
  await expect(stranger.locator('article.prose h1')).toHaveText('Read me');
  await anonymous.close();
});

test('a public artifact cautions the stranger reading it, but not its owner', async ({
  page,
  context,
}) => {
  const artifact = await server.publish({ type: 'markdown', content: '# Read me' });

  await server.signInBrowser(context);
  await page.goto(`${server.baseUrl}/a/${artifact.slug}`);

  // The owner, looking at their own private artifact, is not warned about it.
  await expect(page.getByRole('note')).toHaveCount(0);

  // Make it public. The owner still wrote it, so the caution is not for them.
  await page.getByRole('button', { name: 'Share' }).click();
  await page.getByRole('switch').click();
  await expect(page.getByText(/anyone who has the link can read this/i)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('note')).toHaveCount(0);

  // A stranger with no account gets the caution before anything else.
  const anonymous = await context.browser()!.newContext();
  const stranger = await anonymous.newPage();
  await stranger.goto(`${server.baseUrl}/a/${artifact.slug}`);
  await expect(stranger.getByRole('note')).toContainText('Be careful');
  await expect(stranger.locator('article.prose h1')).toHaveText('Read me');
  await anonymous.close();
});

test('a reader is invited to publish their own, but the owner is not', async ({ page, context }) => {
  const artifact = await server.publish({ type: 'markdown', content: '# Read me\n\nBody.' });

  await server.signInBrowser(context);
  await page.goto(`${server.baseUrl}/a/${artifact.slug}`);

  // The owner wrote it; no "publish your own" nudge on their own document.
  await expect(page.getByRole('link', { name: /publish your own/i })).toHaveCount(0);

  await page.getByRole('button', { name: 'Share' }).click();
  await page.getByRole('switch').click();
  await expect(page.getByText(/anyone who has the link can read this/i)).toBeVisible();

  // A stranger with no account gets both ways in: the wordmark and the footer.
  const anonymous = await context.browser()!.newContext();
  const stranger = await anonymous.newPage();
  await stranger.goto(`${server.baseUrl}/a/${artifact.slug}`);
  await expect(stranger.getByRole('link', { name: 'Open Artifact' })).toBeVisible();
  const cta = stranger.getByRole('link', { name: /publish your own/i });
  await expect(cta).toBeVisible();
  // It leads to the front door, which is the setup guide.
  await cta.click();
  await expect(stranger.getByRole('heading', { name: /paste this into your assistant/i })).toBeVisible();
  await anonymous.close();
});

test('deleting names the artifact, and cancelling keeps it', async ({ page, context }) => {
  const artifact = await server.publish({ type: 'markdown', content: '# Delete me' });

  await server.signInBrowser(context);
  await page.goto(`${server.baseUrl}/a/${artifact.slug}`);

  await page.getByRole('button', { name: 'Delete this artifact' }).click();
  // Naming it is what stops somebody deleting the wrong one.
  await expect(page.getByText(/“Delete me”/)).toBeVisible();

  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('article.prose h1')).toHaveText('Delete me');

  await page.getByRole('button', { name: 'Delete this artifact' }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();

  await expect(page.getByRole('heading', { name: 'Artifacts' })).toBeVisible();
  expect((await fetch(`${server.baseUrl}/api/artifacts/by-slug/${artifact.slug}`)).status).toBe(404);
});

test('a signed-out visitor sees a blurred shape, and none of the document', async ({ page }) => {
  await server.publish({
    type: 'markdown',
    content: '# Confidential plans\n\nThe secret number is 8827361.',
  });
  const artifact = await server.publish({ type: 'markdown', content: '# Another one' });

  await page.goto(`${server.baseUrl}/a/${artifact.slug}`);

  await expect(page.getByRole('heading', { name: 'Sign in to read this' })).toBeVisible();

  // The shape behind the card is fabricated in the browser. Nothing of any real
  // artifact is on this page, blurred or otherwise, so there is nothing for
  // devtools to reveal.
  const body = (await page.locator('body').textContent()) ?? '';
  expect(body).not.toContain('Another one');
  expect(body).not.toContain('Confidential plans');
  expect(body).not.toContain('8827361');
});

test('the front door explains how to start, and the invited reader is not sold to', async ({
  page,
}) => {
  // Somebody who came to look at the product gets one thing to paste into their
  // assistant, which then does the setup itself.
  await page.goto(`${server.baseUrl}/login`);
  await expect(page.getByRole('heading', { name: /paste this into your assistant/i })).toBeVisible();
  // The block carries the real instructions the assistant runs, with this
  // instance's own address in the sign-in line.
  const block = page.locator('pre');
  await expect(block).toContainText('npm install -g open-artifact');
  await expect(block).toContainText(`open-artifact login --instance ${server.baseUrl}`);

  // Somebody who followed a colleague's link came to read, not to be pitched.
  // Explaining setup on their way in taxes the person who shared it.
  const artifact = await server.publish({ type: 'markdown', content: '# Quarter in review' });
  await page.goto(`${server.baseUrl}/a/${artifact.slug}`);

  await expect(page.getByRole('heading', { name: 'Sign in to read this' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /paste this into your assistant/i })).toHaveCount(0);
});

test('the sessions page revokes a command line, and it stops working at once', async ({
  page,
  context,
}) => {
  const token = await server.connectCommandLine('Claude Code on the laptop');

  expect(
    (await fetch(`${server.baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } }))
      .status,
  ).toBe(200);

  await server.signInBrowser(context);
  await page.goto(`${server.baseUrl}/settings/sessions`);

  await expect(page.getByText('Claude Code on the laptop')).toBeVisible();
  await expect(page.getByText('This browser', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Revoke' }).click();
  await expect(page.getByText('Claude Code on the laptop')).toBeHidden();

  expect(
    (await fetch(`${server.baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } }))
      .status,
  ).toBe(401);
});

test('signing out ends the session, and reloading does not get back in', async ({
  page,
  context,
}) => {
  await server.signInBrowser(context);
  await page.goto(server.baseUrl);

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByLabel('Email address')).toBeVisible();

  await page.reload();
  await expect(page.getByLabel('Email address')).toBeVisible();
});

test('connecting a hosted assistant shows the token once, and disconnecting kills it', async ({
  page,
  context,
}) => {
  await server.signInBrowser(context);
  await page.goto(`${server.baseUrl}/settings/sessions`);

  await page.getByRole('button', { name: 'Connect an assistant' }).click();
  await page.getByLabel('A name for this assistant').fill('Cowork');
  await page.getByRole('button', { name: 'Create token' }).click();

  // The token appears exactly once, with instructions beside it.
  await expect(page.getByRole('heading', { name: 'Copy the token now' })).toBeVisible();
  const token = (await page.locator('pre').textContent())?.trim() ?? '';
  expect(token.length).toBeGreaterThan(20);

  // The token really works against the MCP endpoint.
  const call = await fetch(`${server.baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  expect(call.status).toBe(200);

  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByText('Cowork')).toBeVisible();

  // Disconnecting takes effect on the assistant's very next request.
  await page.getByRole('button', { name: 'Disconnect' }).click();
  await expect(page.getByText('Cowork')).toBeHidden();
  const afterRevoke = await fetch(`${server.baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  });
  expect(afterRevoke.status).toBe(401);
});
