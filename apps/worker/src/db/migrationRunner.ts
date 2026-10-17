/**
 * Runtime D1 migration runner (no bundled SQL imports, so it is unit-testable).
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
 *
 * ATOMICITY AND CONCURRENCY
 *
 * Each migration is applied as ONE D1 batch (a transaction) whose FIRST statement
 * records the migration name in `d1_migrations` (UNIQUE). That gives two
 * guarantees the old statement-by-statement loop did not:
 *
 *   - All-or-nothing. A failure part-way rolls back every statement, instead of
 *     leaving earlier statements committed and the migration unrecorded — which
 *     re-ran its DML (UPDATE / INSERT…SELECT data fixes) on every retry.
 *   - One applier across isolates. A deploy starts many isolates at once and each
 *     used to apply the same pending migration concurrently (the only lock was a
 *     per-isolate promise). Now the second isolate's batch fails on the UNIQUE
 *     name and rolls back, so a data migration runs exactly once.
 *
 * The legacy per-statement path is kept ONLY as a fallback for a database whose
 * objects already exist without being recorded (created before tracking, or by
 * hand): there the atomic batch fails with "already exists", and the fallback
 * skips those parts exactly as before.
 */
import type { Env } from "../types";

/** Strip `--` line comments and split a migration file into statements. */
export function splitStatements(sql: string): string[] {
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

/** The batch lost the race: another isolate recorded this migration first. */
function isAlreadyRecorded(message: string): boolean {
  return /UNIQUE constraint failed:\s*d1_migrations\.name/i.test(message);
}

export interface Migration {
  name: string;
  sql: string;
}

/** Legacy per-statement application, for partially pre-existing schemas only. */
async function applyStatementwise(db: D1Database, mig: Migration): Promise<void> {
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
}

export async function runMigrations(env: Pick<Env, "DB">, migrations: readonly Migration[]): Promise<string[]> {
  const db = env.DB;
  const appliedNow: string[] = [];

  // Tracking table (matches the wrangler CLI's schema).
  await db
    .prepare(
      "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
    )
    .run();

  const appliedRes = await db.prepare("SELECT name FROM d1_migrations").all<{ name: string }>();
  const applied = new Set((appliedRes.results ?? []).map((r) => r.name));

  for (const mig of migrations) {
    if (applied.has(mig.name)) continue;
    const statements = splitStatements(mig.sql);
    try {
      await db.batch([
        // Claim FIRST: if another isolate already recorded it, this fails on the
        // UNIQUE name and the whole batch — including the migration body — rolls back.
        db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").bind(mig.name),
        ...statements.map((s) => db.prepare(s)),
      ]);
      appliedNow.push(mig.name);
      console.log(`[migrate] applied ${mig.name}`);
      continue;
    } catch (e: any) {
      const msg = e?.message || String(e);
      if (isAlreadyRecorded(msg)) {
        console.log(`[migrate] ${mig.name} was applied concurrently by another isolate`);
        continue;
      }
      if (!isIgnorable(msg)) throw new Error(`Migration ${mig.name} failed: ${msg}`);
      // Some objects already exist without being recorded. The batch rolled back,
      // so nothing from this attempt is committed; fall back to skipping the parts
      // that are already there.
      console.warn(`[migrate] ${mig.name}: schema partly pre-exists (${msg}); applying statement-by-statement`);
    }
    await applyStatementwise(db, mig);
    appliedNow.push(mig.name);
    console.log(`[migrate] applied ${mig.name} (statement-by-statement)`);
  }
  return appliedNow;
}

