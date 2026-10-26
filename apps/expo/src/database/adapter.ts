import { Platform } from 'react-native';
import SQLiteAdapter from '@nozbe/watermelondb/adapters/sqlite';
import type { DatabaseAdapter } from '@nozbe/watermelondb';

import { schema as appSchema } from './schema';
import { migrations as appMigrations } from './migrations';
import { LOCAL_DB_NAME, type LocalAdapterOptions } from './config';
import { noteSetUpError } from './health';

/**
 * Native (iOS / Android) adapter: SQLite.
 *
 * Metro resolves `./adapter` to this file on native and to `adapter.web.ts` in
 * the web bundle, so the SQLite adapter — which needs a native module — never
 * reaches the browser. `src/database/index.ts` is imported from
 * `app/_layout.tsx`, i.e. on every app start including web, so this split is
 * load-bearing rather than cosmetic.
 *
 * JSI is requested on iOS only. WatermelonDB's Android JSI lives in a separate
 * `native/android-jsi` project that autolinking does not include (only
 * `native/android` is linked; see docs/LOCAL_DATA.md), so on Android `jsi: true`
 * always fell back to the asynchronous bridge after logging a warning. Asking
 * for what actually runs keeps the behaviour identical and the log honest.
 *
 * Exported as a factory so tests build the database with exactly this
 * configuration (test/helpers/localDb.ts).
 */
export function createAdapter(options: LocalAdapterOptions = {}): DatabaseAdapter {
  const adapter = new SQLiteAdapter({
    schema: options.schema ?? appSchema,
    migrations: options.migrations ?? appMigrations,
    dbName: options.dbName ?? LOCAL_DB_NAME,
    jsi: Platform.OS === 'ios',
    // A corrupted or un-migratable local cache must not take the app down. The
    // health module records it and schedules one guarded reset.
    onSetUpError: (error) => noteSetUpError(error, Platform.OS),
  });
  // The adapter also rejects its internal setup promise with the same error.
  // onSetUpError has already reported it; left unhandled it becomes a second,
  // unattributed "unhandled promise rejection" for the same failure.
  (adapter as any)._initPromise?.catch?.(() => undefined);
  return adapter as unknown as DatabaseAdapter;
}
