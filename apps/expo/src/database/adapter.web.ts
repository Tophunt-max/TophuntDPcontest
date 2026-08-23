import LokiJSAdapter from '@nozbe/watermelondb/adapters/lokijs';
import type { DatabaseAdapter } from '@nozbe/watermelondb';

import { schema } from './schema';
import { migrations } from './migrations';

/**
 * Web adapter (IndexedDB via LokiJS).
 *
 * Metro picks this file over `adapter.ts` for the web bundle. The SQLite
 * adapter cannot run in a browser, and `src/database/index.ts` is imported at
 * the app root, so the web build needs a real adapter rather than a stub.
 */
export const adapter: DatabaseAdapter = new LokiJSAdapter({
  schema,
  migrations,
  dbName: 'tophunt_stories',
  useWebWorker: false,
  useIncrementalIndexedDB: true,
  onSetUpError: (error) => {
    console.error('[database] LokiJS setup failed:', error);
  },
}) as unknown as DatabaseAdapter;
