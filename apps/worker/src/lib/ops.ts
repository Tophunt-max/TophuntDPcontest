import { desc, eq, lt } from "drizzle-orm";
import type { Env } from "../types";
import { getDb, schema } from "../db";
import { newId, now } from "./ids";
import { captureError, logErrorToDb } from "./observability";

/**
 * Cron observability.
 *
 * Before this, `scheduled()` fired every job inside `ctx.waitUntil` and logged
 * nothing on completion. That meant:
 *
 *  - a cron that stopped firing altogether was undetectable;
 *  - a job that threw only produced a `console.error` nobody was watching, while
 *    real payouts and refunds silently stopped happening.
 *
 * Every run now writes a row: name, outcome, duration and a short result
 * summary. That gives three things at once — a heartbeat (is the cron alive?),
 * a duration metric (is the 10-minute job about to overrun its window?), and a
 * failure trail that the deep health check and the admin panel can both read.
 */

/** A run older than this makes the corresponding job "stale" in health checks. */
export const CRON_STALE_AFTER_MS: Record<string, number> = {
  // The 10-minute tick: allow three missed ticks before calling it stale.
  resolveContests: 35 * 60 * 1000,
  reconcilePayments: 35 * 60 * 1000,
  pruneErrorLogs: 35 * 60 * 1000,
  pruneNotifications: 35 * 60 * 1000,
  pruneIdempotencyKeys: 35 * 60 * 1000,
  reconcileVideos: 35 * 60 * 1000,
  // Monthly: allow a couple of days of slack.
  monthlyHallOfFame: 34 * 24 * 60 * 60 * 1000,
};

const CRON_RUN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface CronRunOutcome<T> {
  ok: boolean;
  durationMs: number;
  result?: T;
  error?: unknown;
}

/**
 * Run one cron job with timing, a persisted heartbeat, and real alerting on
 * failure. Never throws: one failing job must not prevent the others in the
 * same tick from running.
 */
export async function runCronJob<T>(
  env: Env,
  name: string,
  job: () => Promise<T>,
): Promise<CronRunOutcome<T>> {
  const startedAt = Date.now();
  try {
    const result = await job();
    const durationMs = Date.now() - startedAt;
    console.log(JSON.stringify({ level: "info", cron: name, ok: true, ms: durationMs, result }));
    await recordCronRun(env, name, true, durationMs, result);
    return { ok: true, durationMs, result };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ level: "error", cron: name, ok: false, ms: durationMs, message }));
    await recordCronRun(env, name, false, durationMs, { message });
    // A failed cron is an operational incident: it is persisted for the admin
    // panel, forwarded to Sentry, and raised as an admin notification so a
    // stalled payout run is visible without reading logs.
    await logErrorToDb(env, error, { path: `cron:${name}`, method: "CRON" });
    await captureError(env, error, { path: `cron:${name}`, method: "CRON", tags: { cron: name } });
    await raiseOpsAlert(
      env,
      `Cron failed: ${name}`,
      `${message} (after ${durationMs}ms). Contest settlement, refunds or payouts may be delayed.`,
    );
    return { ok: false, durationMs, error };
  }
}

async function recordCronRun(
  env: Env,
  name: string,
  ok: boolean,
  durationMs: number,
  detail: unknown,
): Promise<void> {
  try {
    await getDb(env).insert(schema.cronRuns).values({
      id: newId(),
      job: name,
      ok,
      durationMs,
      detail: (detail ?? null) as any,
      createdAt: now(),
    });
  } catch (e) {
    console.error("[ops] failed to record cron run", name, e);
  }
}

/** Best-effort admin-visible alert. Never throws. */
export async function raiseOpsAlert(env: Env, title: string, message: string): Promise<void> {
  try {
    await getDb(env).insert(schema.adminNotifications).values({
      id: newId(),
      title,
      message: message.slice(0, 2000),
      link: "/logs",
      createdAt: now(),
    });
  } catch (e) {
    console.error("[ops] failed to raise alert", title, e);
  }
}

export interface CronHealth {
  job: string;
  lastRunAt: number | null;
  lastOk: boolean | null;
  lastDurationMs: number | null;
  stale: boolean;
}

/** Latest run per job + whether it is overdue. Used by the deep health check. */
export async function cronHealth(env: Env): Promise<CronHealth[]> {
  const db = getDb(env);
  const out: CronHealth[] = [];
  for (const [job, staleAfter] of Object.entries(CRON_STALE_AFTER_MS)) {
    const last = await db
      .select()
      .from(schema.cronRuns)
      .where(eq(schema.cronRuns.job, job))
      .orderBy(desc(schema.cronRuns.createdAt))
      .limit(1)
      .get();
    out.push({
      job,
      lastRunAt: last?.createdAt ?? null,
      lastOk: last ? !!last.ok : null,
      lastDurationMs: last?.durationMs ?? null,
      // Never having run is only "stale" once the app has had a chance to run it;
      // an empty table on a fresh deploy would otherwise report unhealthy.
      stale: last ? Date.now() - Number(last.createdAt) > staleAfter : false,
    });
  }
  return out;
}

/** Retention for the heartbeat table and expired replay claims. */
export async function pruneOpsTables(env: Env): Promise<{ cronRuns: number; idempotencyKeys: number }> {
  const cutoff = Date.now() - CRON_RUN_RETENTION_MS;
  const runs = await env.DB.prepare("DELETE FROM cron_runs WHERE created_at < ?").bind(cutoff).run();
  // Replay claims only need to outlive any plausible client retry window. A week
  // is generous; keeping them forever would grow the table without bound.
  const keyCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const keys = await env.DB.prepare("DELETE FROM idempotency_keys WHERE created_at < ?")
    .bind(keyCutoff)
    .run();
  return {
    cronRuns: Number(runs.meta?.changes || 0),
    idempotencyKeys: Number(keys.meta?.changes || 0),
  };
}

/** Suppress duplicate alerts for the same key within a window. */
export async function alertOnce(
  env: Env,
  key: string,
  windowMs: number,
  title: string,
  message: string,
): Promise<boolean> {
  const db = getDb(env);
  const ts = now();
  const claimKey = `alert:${key}:${Math.floor(ts / windowMs)}`;
  const claim = await db
    .insert(schema.idempotencyKeys)
    .values({ key: claimKey, nonce: crypto.randomUUID(), scope: "alert", createdAt: ts })
    .onConflictDoNothing()
    .run();
  if (Number(claim.meta?.changes || 0) === 0) return false;
  await raiseOpsAlert(env, title, message);
  return true;
}

/** Remove alert-suppression claims that have aged out (called with pruneOpsTables). */
export async function pruneAlertClaims(env: Env): Promise<void> {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  await getDb(env)
    .delete(schema.idempotencyKeys)
    .where(lt(schema.idempotencyKeys.createdAt, cutoff))
    .run();
}
