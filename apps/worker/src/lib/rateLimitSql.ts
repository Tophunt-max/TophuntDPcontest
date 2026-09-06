/**
 * The RateLimiter actor's SQL, as constants.
 *
 * Its own module for the same reason as lib/rateLimitWindow.ts: src/rateLimiter.ts
 * imports `cloudflare:workers` and so cannot be loaded by the Node test harness,
 * which means the actor's SQL — the counter itself — would otherwise be the one
 * part of a rate limiter with no test at all. `node:sqlite` (already used by the D1
 * shim) runs these statements verbatim, so `test/rateLimiterSql.test.ts` exercises
 * the REAL boundary condition, the REAL upsert and the REAL pruning cycle rather
 * than a hand-written mirror that could agree with a bug.
 *
 * Kept as strings rather than a query builder deliberately: the whole value here is
 * that the test and the actor run byte-identical SQL.
 */

/** Idempotent schema. Safe to run in the actor constructor on every wake. */
export const RATE_LIMIT_DDL: readonly string[] = [
  // Keyed on (key, window_id) so the upsert below IS the whole counter: no
  // read-modify-write, and no way for two rows to describe the same window.
  `CREATE TABLE IF NOT EXISTS windows (
     key        TEXT NOT NULL,
     window_id  INTEGER NOT NULL,
     count      INTEGER NOT NULL DEFAULT 0,
     expires_at INTEGER NOT NULL,
     PRIMARY KEY (key, window_id)
   );`,
  // Pruning scans by expiry, and this table is written on every throttled action,
  // so the index earns its upkeep.
  `CREATE INDEX IF NOT EXISTS idx_windows_expires ON windows(expires_at);`,
];

/** Current usage of one key in one window. */
export const SQL_SELECT_COUNT =
  "SELECT count FROM windows WHERE key = ? AND window_id = ? LIMIT 1";

/**
 * Consume one unit.
 *
 * `expires_at = excluded.expires_at` on the update is not redundant. A row is
 * created by whichever call first touches that (key, window), and today every call
 * site uses one window size per key — but a future caller reusing an existing key
 * with a different `windowSec` would otherwise leave a row whose `expires_at`
 * describes the FIRST caller's window while its `window_id` describes the second's.
 * The pruner trusts `expires_at`, so that row would be collected early or late.
 * Refreshing it costs nothing and removes the trap.
 */
export const SQL_CONSUME = `INSERT INTO windows (key, window_id, count, expires_at) VALUES (?, ?, 1, ?)
   ON CONFLICT(key, window_id) DO UPDATE SET count = count + 1, expires_at = excluded.expires_at`;

/** Drop rows whose window closed before the cutoff. */
export const SQL_PRUNE = "DELETE FROM windows WHERE expires_at <= ?";

/**
 * The next expiry still on file, and how many rows remain.
 *
 * MIN, not MAX. Re-arming from the LATEST expiry would pin every short row to the
 * actor's longest live window: one 24-hour row (`upload_day`, `exportdata`,
 * `otpsend_num`, `pushday`) would keep a day's worth of 60-second rows alive
 * alongside it, and then delete thousands of them in a single alarm — and deletes
 * are billed as rows written, so that arrives as one spike against the daily
 * budget. Pruning from the earliest expiry costs more alarms and keeps both the row
 * count and the write burst bounded.
 *
 * `remaining` is returned in the same query because the alarm needs it to decide
 * whether to re-arm, and a second round trip for a COUNT would be a second billed
 * row read.
 */
export const SQL_NEXT_EXPIRY =
  "SELECT MIN(expires_at) AS next, COUNT(*) AS remaining FROM windows";

/** Forget one key entirely (operator recovery / tests). */
export const SQL_RESET = "DELETE FROM windows WHERE key = ?";
