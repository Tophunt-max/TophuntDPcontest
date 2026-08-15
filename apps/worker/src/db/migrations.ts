/**
 * Ordered list of D1 migrations, embedded into the Worker bundle as text (via
 * the wrangler `[[rules]] type = "Text"` config). This lets the Worker apply
 * pending migrations itself at runtime (src/db/autoMigrate.ts) so deploys —
 * whether via `wrangler deploy`, a directly-connected Cloudflare Workers Build,
 * or a manual upload — never need a separate migration step.
 *
 * IMPORTANT: keep this list in sync with the files in `migrations/`. Each new
 * migration file must be imported and appended here, and `name` must exactly
 * match the filename (that is the key stored in the `d1_migrations` table, the
 * same table the wrangler CLI uses, so the two never double-apply).
 *
 * Write migrations idempotently where possible (CREATE TABLE/INDEX IF NOT
 * EXISTS). `ALTER TABLE ADD COLUMN` is not idempotent; the runner tolerates
 * "duplicate column" errors so an already-applied column is skipped safely.
 */
import m0000 from "../../migrations/0000_init.sql";
import m0001 from "../../migrations/0001_phase4.sql";
import m0002 from "../../migrations/0002_admin_notifications.sql";
import m0003 from "../../migrations/0003_blog.sql";
import m0004 from "../../migrations/0004_blog_seo_import.sql";
import m0005 from "../../migrations/0005_admin_features.sql";

export interface Migration {
  name: string; // must equal the filename in migrations/
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  { name: "0000_init.sql", sql: m0000 },
  { name: "0001_phase4.sql", sql: m0001 },
  { name: "0002_admin_notifications.sql", sql: m0002 },
  { name: "0003_blog.sql", sql: m0003 },
  { name: "0004_blog_seo_import.sql", sql: m0004 },
  { name: "0005_admin_features.sql", sql: m0005 },
];
