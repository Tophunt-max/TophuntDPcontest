import LokiJSAdapter from '@nozbe/watermelondb/adapters/lokijs';
import type { DatabaseAdapter } from '@nozbe/watermelondb';

import { schema as appSchema } from './schema';
import { migrations as appMigrations } from './migrations';
import { LOCAL_DB_NAME, type LocalAdapterOptions } from './config';
import { noteOverwrittenByOtherTab, noteQuotaExceeded, noteSetUpError, noteStorageClosed } from './health';

/**
 * Web adapter: LokiJS in memory, persisted to IndexedDB.
 *
 * Metro picks this file over `adapter.ts` for the web bundle. The SQLite
 * adapter cannot run in a browser, and `src/database/index.ts` is imported at
 * the app root, so the web build needs a real adapter rather than a stub.
 *
 * Durability model (verified against the real adapter in
 * test/localDbWeb.test.ts):
 * - Reads and writes hit Loki's in-memory copy. Loki autosaves changed chunks
 *   to IndexedDB every 500 ms, so a tab closed within that window loses the
 *   last writes. `flushLokiAdapter` saves immediately and is called when the
 *   page is hidden, which is the last reliable moment a browser gives a tab.
 * - No IndexedDB at all (some private modes, blocked storage): Loki falls back
 *   to memory on its own. The app works; nothing survives a reload.
 * - Quota exceeded, IndexedDB deleted underneath us, or another tab
 *   overwriting this one are recorded in the health module.
 */
export function createAdapter(options: LocalAdapterOptions = {}): DatabaseAdapter {
  return new LokiJSAdapter({
    schema: options.schema ?? appSchema,
    migrations: options.migrations ?? appMigrations,
    dbName: options.dbName ?? LOCAL_DB_NAME,
    useWebWorker: false,
    useIncrementalIndexedDB: true,
    onSetUpError: (error) => noteSetUpError(error, 'web'),
    onQuotaExceededError: (error) => noteQuotaExceeded(error),
    extraIncrementalIDBOptions: {
      onversionchange: () => noteStorageClosed(),
      onDidOverwrite: () => noteOverwrittenByOtherTab(),
    },
  }) as unknown as DatabaseAdapter;
}

/**
 * Save Loki's in-memory changes to IndexedDB now instead of at the next
 * autosave tick. Resolves `false` when there is nothing reachable to save
 * (adapter still setting up, persistence unavailable) — never throws.
 *
 * WatermelonDB has no public flush, so this reaches the Loki instance through
 * the synchronous-worker path that `useWebWorker: false` uses. That path is
 * pinned by test/localDbWeb.test.ts, so an upgrade that moves it fails a test
 * instead of silently turning this into a no-op.
 */
export function flushLokiAdapter(adapter: unknown): Promise<boolean> {
  const loki = (adapter as any)?._dispatcher?._worker?._bridge?.driver?.loki;
  if (!loki || typeof loki.saveDatabase !== 'function') return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      loki.saveDatabase((err: unknown) => resolve(!err));
    } catch {
      resolve(false);
    }
  });
}

/** Flush whenever the page is hidden or unloaded. Idempotent per adapter. */
export function installFlushOnHide(adapter: unknown): void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  const a = adapter as any;
  if (a.__tophuntFlushInstalled) return;
  a.__tophuntFlushInstalled = true;
  const flush = () => void flushLokiAdapter(adapter);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
  window.addEventListener('pagehide', flush);
}
