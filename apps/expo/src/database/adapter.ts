import SQLiteAdapter from '@nozbe/watermelondb/adapters/sqlite';
import type { DatabaseAdapter } from '@nozbe/watermelondb';

import { schema } from './schema';
import { migrations } from './migrations';

/**
 * Native (iOS / Android) adapter.
 *
 * Metro resolves `./adapter` to this file on native and to `adapter.web.ts` in
 * the web bundle, so the SQLite adapter — which needs a native module — never
 * reaches the browser. `src/database/index.ts` is imported from
 * `app/_layout.tsx`, i.e. on every app start including web, so this split is
 * load-bearing rather than cosmetic.
 */
export const adapter: DatabaseAdapter = new SQLiteAdapter({
  schema,
  migrations,
  dbName: 'tophunt_stories',
  jsi: true,
  onSetUpError: (error) => {
    // A corrupted or un-migratable local cache must not take the app down: the
    // stories layer already falls back to the network on any local failure.
    console.error('[database] SQLite setup failed:', error);
  },
}) as unknown as DatabaseAdapter;
