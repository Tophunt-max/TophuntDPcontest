/**
 * Public migrations module. The actual list is auto-generated from the .sql
 * files in migrations/ by scripts/gen-migrations.mjs (run on every build/deploy
 * and typecheck), so there is no hand-maintained list: dropping a new
 * NNNN_name.sql file into migrations/ is all that's needed.
 *
 * See src/db/autoMigrate.ts for how these are applied at runtime.
 */
export type { Migration } from "./migrations.generated";
export { MIGRATIONS } from "./migrations.generated";
