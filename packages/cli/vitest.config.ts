import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    hookTimeout: 20000,
    testTimeout: 20000,
  },
});
