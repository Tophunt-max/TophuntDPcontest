/**
 * Real WatermelonDB databases for tests, built from the PRODUCTION adapter
 * factories in src/database/adapter.ts (native SQLite) and adapter.web.ts
 * (LokiJS + IndexedDB).
 *
 * - SQLite runs WatermelonDB's Node driver against `node:sqlite` through
 *   ./betterSqlite3Shim.cjs, so the SQL the app executes on iOS/Android runs on
 *   a real SQLite engine here.
 * - Web runs the real LokiJS adapter against `fake-indexeddb`, which persists
 *   across adapter instances in one test process, so "close the tab and come
 *   back" is a new adapter on the same dbName.
 *
 * Callers must `vi.mock('react-native', ...)` (adapter.ts reads Platform) and
 * import `fake-indexeddb/auto` before using the web half.
 */
import Module from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { appSchema, tableSchema, Database } from '@nozbe/watermelondb';
import { schemaMigrations } from '@nozbe/watermelondb/Schema/migrations';

import { schema } from '@/src/database/schema';
import { migrations } from '@/src/database/migrations';
import { StoryModel } from '@/src/database/models/StoryModel';
import { UserStoryModel } from '@/src/database/models/UserStoryModel';
import { PendingActionModel } from '@/src/database/models/PendingActionModel';
import { FeedSnapshotModel } from '@/src/database/models/FeedSnapshotModel';

const here = path.dirname(fileURLToPath(import.meta.url));
const SHIM = path.join(here, 'betterSqlite3Shim.cjs');

let shimInstalled = false;
/** Route WatermelonDB's `require('better-sqlite3')` to the node:sqlite shim. */
export function installSqliteShim(): void {
  if (shimInstalled) return;
  shimInstalled = true;
  const M = Module as any;
  const original = M._resolveFilename;
  M._resolveFilename = function (request: string, ...rest: any[]) {
    if (request === 'better-sqlite3') return SHIM;
    return original.call(this, request, ...rest);
  };
}

export const modelClasses = [StoryModel, UserStoryModel, PendingActionModel, FeedSnapshotModel];

/** A fresh on-disk SQLite path (file-backed, so "restart" means reopening it). */
export function tempSqlitePath(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tophunt-db-'));
  return path.join(dir, `${label}.db`);
}

/**
 * The schema as it shipped at `version`, reconstructed by removing everything
 * the migrations added after it. Lets a test build the database an old app
 * version left on a device, then open it with the current app.
 */
export function schemaAtVersion(version: number) {
  const later = ((migrations as any).sortedMigrations as any[]).filter((m) => m.toVersion > version);
  const droppedColumns = new Map<string, Set<string>>();
  const droppedTables = new Set<string>();
  for (const m of later) {
    for (const step of m.steps) {
      if (step.type === 'add_columns') {
        const set = droppedColumns.get(step.table) ?? new Set<string>();
        for (const c of step.columns) set.add(c.name);
        droppedColumns.set(step.table, set);
      } else if (step.type === 'create_table') {
        droppedTables.add(step.schema.name);
      } else {
        throw new Error(`schemaAtVersion: unhandled migration step ${step.type}`);
      }
    }
  }
  const tables = Object.values(schema.tables as any)
    .filter((t: any) => !droppedTables.has(t.name))
    .map((t: any) =>
      tableSchema({
        name: t.name,
        columns: t.columnArray.filter((c: any) => !droppedColumns.get(t.name)?.has(c.name)),
      }),
    );
  return appSchema({ version, tables });
}

/** The migrations an app at `version` shipped with (none above its schema). */
export function migrationsUpTo(version: number) {
  const steps = ((migrations as any).sortedMigrations as any[]).filter((m) => m.toVersion <= version);
  return schemaMigrations({ migrations: steps });
}

/** A Database with the app's models (only those whose table the schema has). */
export function makeDatabase(adapter: any): Database {
  const tables = adapter.schema.tables as Record<string, unknown>;
  return new Database({ adapter, modelClasses: modelClasses.filter((m) => m.table in tables) });
}
