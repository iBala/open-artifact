import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests run against a real server in a real browser.
 *
 * Some of what this project promises cannot be checked any other way. A response
 * header saying an iframe is sandboxed is not evidence that script inside it is
 * actually contained; only a browser can tell us that.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    trace: 'on-first-retry',
    // Each test starts its own server and sets this itself.
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:4310',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
