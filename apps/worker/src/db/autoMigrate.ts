/**
 * Runtime D1 auto-migrator.
 *
 * On the first request handled by a fresh Worker isolate, this applies any
 * migrations from `migrations.ts` that haven't been recorded yet. Applied
 * migrations are tracked in the `d1_migrations` table — the SAME table the
 * `wrangler d1 migrations apply` CLI uses — so the runtime path and the CLI
 * never double-apply, and an existing database (already migrated via the CLI)
 * only ever gets genuinely-new migrations.
 *
 * The result is a deploy that needs no separate migration step: push code to a
 * directly-connected Cloudflare Worker and the schema catches up on first hit.
 */
import type { Env } from "../types";
import { MIGRATIONS } from "./migrations";

/** Strip `--` line comments and split a migration file into statements. */
function splitStatements(sql: string): string[] {
  const withoutComments = sql
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join("\n");
  return withoutComments
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Errors that mean "this bit is already applied" — safe to skip. */
function isIgnorable(message: string): boolean {
  return /duplicate column name|already exists/i.test(message);
}

async function runMigrations(env: Env): Promise<void> {
  const db = env.DB;

  // Tracking table (matches the wrangler CLI's schema).
  await db
    .prepare(
      "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
    )
    .run();

  const appliedRes = await db.prepare("SELECT name FROM d1_migrations").all<{ name: string }>();
  const applied = new Set((appliedRes.results ?? []).map((r) => r.name));

  for (const mig of MIGRATIONS) {
    if (applied.has(mig.name)) continue;
    for (const stmt of splitStatements(mig.sql)) {
      try {
        await db.prepare(stmt).run();
      } catch (e: any) {
        const msg = e?.message || String(e);
        if (isIgnorable(msg)) {
          console.warn(`[migrate] skipping already-applied part of ${mig.name}: ${msg}`);
          continue;
        }
        throw new Error(`Migration ${mig.name} failed: ${msg}`);
      }
    }
    await db.prepare("INSERT OR IGNORE INTO d1_migrations (name) VALUES (?)").bind(mig.name).run();
    console.log(`[migrate] applied ${mig.name}`);
  }
}

// One run per isolate. Concurrent first requests all await the same promise; a
// failure clears the cache so the next request retries (rather than caching a
// permanently-rejected promise).
let migrationPromise: Promise<void> | null = null;

export function ensureMigrated(env: Env): Promise<void> {
  if (!migrationPromise) {
    migrationPromise = runMigrations(env).catch((e) => {
      migrationPromise = null;
      throw e;
    });
  }
  return migrationPromise;
}
