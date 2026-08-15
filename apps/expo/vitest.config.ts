import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Unit tests for the pure service/logic layer (no React Native renderer). Native
// modules are mocked per-test, so these run in plain Node — component tests that
// need the RN renderer would use jest-expo separately.
const dir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: { '@': dir },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
