import { schemaMigrations } from '@nozbe/watermelondb/Schema/migrations';

/**
 * Schema migrations for the local stories cache.
 *
 * `schema.ts` is still at version 1, so there is nothing to migrate *from* yet
 * and the list is intentionally empty. When you bump the schema version, add a
 * matching entry here:
 *
 *   migrations: [
 *     { toVersion: 2, steps: [addColumns({ table: 'stories', columns: [...] })] },
 *   ]
 *
 * Note `Migration` is not an export of `@nozbe/watermelondb` — migrations must
 * be built through `schemaMigrations()`, which returns the validated shape the
 * adapter expects.
 */
export const migrations = schemaMigrations({
  migrations: [],
});
