import { defineConfig } from 'vitest/config';

// Plain Node environment. The worker handlers run against a node:sqlite-backed
// D1 shim (see test/helpers/harness.ts) — no workerd required, so this suite
// runs in any Node 22+ environment.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    hookTimeout: 20000,
    testTimeout: 20000,
  },
});
