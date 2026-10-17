/**
 * Runtime D1 auto-migrator: applies the bundled migrations on the first request
 * of each isolate. The transactional, single-applier logic lives in
 * ./migrationRunner (see its header for the atomicity/concurrency contract).
 */
import type { Env } from "../types";
import { MIGRATIONS } from "./migrations";
import { runMigrations } from "./migrationRunner";

// One run per isolate. Concurrent first requests all await the same promise. A
// failure is remembered for a short backoff, so a broken migration is retried
// periodically rather than re-executed on EVERY request (which hammered D1 and
// added its latency to the hot path).
const FAILURE_BACKOFF_MS = 30_000;
let migrationPromise: Promise<void> | null = null;
let lastFailure: { at: number; error: unknown } | null = null;

export function ensureMigrated(env: Env): Promise<void> {
  if (lastFailure && Date.now() - lastFailure.at < FAILURE_BACKOFF_MS) {
    return Promise.reject(lastFailure.error);
  }
  if (!migrationPromise) {
    migrationPromise = runMigrations(env, MIGRATIONS).then(
      () => {
        lastFailure = null;
      },
      (e) => {
        migrationPromise = null;
        lastFailure = { at: Date.now(), error: e };
        throw e;
      },
    );
  }
  return migrationPromise;
}

/** Test-only: forget per-isolate state. */
export function resetMigrationStateForTests(): void {
  migrationPromise = null;
  lastFailure = null;
}
