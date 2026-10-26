/**
 * Anonymous product counters (feed impressions, Story completion, video start and
 * stalls, search, offline sync, uploads), stored in Workers Analytics Engine.
 *
 * Why Analytics Engine and not D1 or a Durable Object: these are high-volume
 * writes nobody reads row by row. D1 has one writer and a daily row-write budget
 * shared with the product; a DO request is billed against the same 100k/day as
 * the realtime hub. Analytics Engine is built for this: one `writeDataPoint` per
 * aggregated counter, no state of ours, 3-month retention, queried with SQL.
 *
 * Privacy rules, enforced here rather than trusted from the app:
 *  - closed vocabulary: an event name and a dimension from ANALYTICS_EVENTS;
 *    anything else is dropped;
 *  - no identifiers: no uid, no device id, no IP, no content ids. The only other
 *    fields are the platform enum and the app version (`1.2.3` shape);
 *  - the app aggregates before sending (`count` and a summed `ms`), so a batch
 *    is a handful of points, not one per action;
 *  - the user can turn it off in Settings › Privacy (the app then never sends).
 * When the ANALYTICS binding is absent (local, tests, a deploy without it) the
 * batch is accepted and discarded.
 */
import type { Env } from "../types";

export const ANALYTICS_EVENTS = {
  feed_impression: ["home"],
  story: ["complete", "skip", "close"],
  video: ["first_frame", "stall", "error"],
  search: ["results", "empty"],
  sync: ["sent", "retry", "failed"],
  upload: ["ok", "failed", "cancelled"],
} as const satisfies Record<string, readonly string[]>;
export type AnalyticsEventName = keyof typeof ANALYTICS_EVENTS;

/** Bounds for one POST. The real payload is well under this. */
export const USAGE_MAX_BYTES = 4096;
export const USAGE_MAX_EVENTS = 50;
const MAX_COUNT = 1000;
/** Per-occurrence ceiling for a duration (10 minutes). */
const MAX_MS = 600_000;
const PLATFORMS = new Set(["ios", "android", "web"]);
const VERSION = /^\d{1,3}(\.\d{1,3}){0,3}$/;

export interface UsagePoint {
  name: AnalyticsEventName;
  dim: string;
  count: number;
  ms: number;
}

/**
 * The valid, clamped points in a batch, merged per (name, dim). Never throws:
 * a bad entry is skipped, so one stale app build cannot poison a whole batch.
 */
export function parseUsageBatch(body: any): { platform: string; version: string; points: UsagePoint[] } {
  const platform = PLATFORMS.has(body?.platform) ? String(body.platform) : "other";
  const version = typeof body?.v === "string" && VERSION.test(body.v) ? body.v : "unknown";
  const merged = new Map<string, UsagePoint>();
  const events = Array.isArray(body?.events) ? body.events.slice(0, USAGE_MAX_EVENTS) : [];
  for (const e of events) {
    const name = e?.n as AnalyticsEventName;
    const dims = (ANALYTICS_EVENTS as Record<string, readonly string[]>)[name];
    if (!dims || typeof e?.d !== "string" || !dims.includes(e.d)) continue;
    const count = Number.isInteger(e.c) && e.c > 0 ? Math.min(e.c, MAX_COUNT) : 1;
    const msRaw = Number(e.ms);
    const ms = Number.isFinite(msRaw) && msRaw > 0 ? Math.min(Math.round(msRaw), count * MAX_MS) : 0;
    const key = `${name}|${e.d}`;
    const prev = merged.get(key);
    if (prev) {
      prev.count = Math.min(prev.count + count, MAX_COUNT);
      prev.ms = Math.min(prev.ms + ms, prev.count * MAX_MS);
    } else {
      merged.set(key, { name, dim: e.d, count, ms });
    }
  }
  return { platform, version, points: [...merged.values()] };
}

/** Write the points; returns how many were written (0 without the binding). */
export function writeUsagePoints(env: Env, batch: ReturnType<typeof parseUsageBatch>): number {
  const ds = env.ANALYTICS;
  if (!ds) return 0;
  let n = 0;
  for (const p of batch.points) {
    try {
      // blob1..4 = name, dim, platform, version; double1 = count, double2 = summed ms.
      ds.writeDataPoint({ indexes: [p.name], blobs: [p.name, p.dim, batch.platform, batch.version], doubles: [p.count, p.ms] });
      n++;
    } catch (e) {
      console.error("[usage] writeDataPoint failed (dropping)", e);
      break;
    }
  }
  return n;
}

// ---------------------------------------------------------------- reading

const DATASET = /^[a-z0-9_]{1,64}$/;

export interface UsageSummaryRow {
  name: string;
  dim: string;
  platform: string;
  count: number;
  /** Mean duration per occurrence in ms, when the event carries one. */
  avgMs: number | null;
}

/** SQL for the admin summary. `days` and the dataset are validated, not bound. */
export function usageSummarySql(dataset: string, days: number): string {
  if (!DATASET.test(dataset)) throw new Error("bad dataset name");
  const d = Math.min(90, Math.max(1, Math.floor(days)));
  return (
    "SELECT blob1 AS name, blob2 AS dim, blob3 AS platform, " +
    "SUM(_sample_interval * double1) AS count, SUM(_sample_interval * double2) AS ms " +
    `FROM ${dataset} WHERE timestamp > NOW() - INTERVAL '${d}' DAY ` +
    "GROUP BY name, dim, platform ORDER BY count DESC LIMIT 500 FORMAT JSON"
  );
}

/**
 * Counters for the last `days` days via the Analytics Engine SQL API, or null when
 * the read token or account id is not configured. Uses the same read-only
 * CF_ANALYTICS_TOKEN as the capacity widget (needs Account Analytics: Read).
 */
export async function fetchUsageSummary(env: Env, days: number): Promise<UsageSummaryRow[] | null> {
  const token = env.CF_ANALYTICS_TOKEN;
  const account = env.CF_ACCOUNT_ID;
  if (!token || !account) return null;
  const sql = usageSummarySql(env.ANALYTICS_DATASET || "tophunt_events", days);
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/analytics_engine/sql`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: sql,
  });
  if (!res.ok) {
    console.error("[usage] SQL API answered", res.status);
    return null;
  }
  const json = (await res.json().catch(() => null)) as any;
  const rows: any[] = Array.isArray(json?.data) ? json.data : [];
  return rows.map((r) => {
    const count = Number(r.count) || 0;
    const ms = Number(r.ms) || 0;
    return { name: String(r.name), dim: String(r.dim), platform: String(r.platform), count: Math.round(count), avgMs: count > 0 && ms > 0 ? Math.round(ms / count) : null };
  });
}
