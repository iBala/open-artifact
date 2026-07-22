import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Generous, because every package's suite runs at once and these tests
    // start real servers. A timeout that only fails on a loaded machine is a
    // flake, and a flake teaches people to re-run rather than to look.
    hookTimeout: 45000,
    testTimeout: 45000,
  },
});
