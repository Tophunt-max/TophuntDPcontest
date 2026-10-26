import type { AppSchema } from '@nozbe/watermelondb';
import type { SchemaMigrations } from '@nozbe/watermelondb/Schema/migrations';

/**
 * On-device database name. Changing it orphans every existing install's data
 * (a new, empty database is created beside the old one), so it is fixed.
 */
export const LOCAL_DB_NAME = 'tophunt_stories';

/** Overrides for tests. Production always uses the defaults. */
export interface LocalAdapterOptions {
  dbName?: string;
  schema?: AppSchema;
  migrations?: SchemaMigrations;
}
