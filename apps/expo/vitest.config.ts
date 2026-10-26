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
  // Class fields must compile the way the app's Babel pipeline compiles them
  // (babel.config.js). The WatermelonDB models declare decorated fields with no
  // initializer (`@field('type') type!: string`); [[Define]] semantics give each
  // instance an own `type = undefined` that shadows the decorator's accessor, so
  // every column is stored empty. Vite reads `useDefineForClassFields: false`
  // from tsconfig.json for this. Legacy decorators are set explicitly to match
  // `experimentalDecorators` there. Without both, the real-database tests
  // (test/localDb*.test.ts) would exercise something the app never runs.
  oxc: {
    decorator: { legacy: true },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
