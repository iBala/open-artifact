import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // The update check reaches out to public npm on a real run. Off for the whole
    // suite so no test touches the network for it; version-check.test.ts drives
    // the check directly with an injected fetch instead.
    env: { OPEN_ARTIFACT_NO_UPDATE_CHECK: '1' },
    // Generous, because every package's suite runs at once and these tests
    // start real servers. A timeout that only fails on a loaded machine is a
    // flake, and a flake teaches people to re-run rather than to look.
    hookTimeout: 45000,
    testTimeout: 45000,
  },
});
