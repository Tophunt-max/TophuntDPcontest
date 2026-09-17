/**
 * Capacity snapshot for the admin dashboard "Database Capacity" widget.
 *
 * Answers, in-panel, "how close are we to a Cloudflare free-tier wall, and which
 * table is growing toward a staged lever?" — the same question `npm run capacity`
 * answers on the CLI (see CAPACITY_MONITORING.md).
 *
 * Two data sources, both fail-open:
 *   - Growth-table row counts + DB file size — measured in-Worker from D1 (one
 *     COUNT sweep, memoised 5 min so the dashboard poll doesn't re-run it).
 *   - Today's live rows_read / rows_written — from the Cloudflare GraphQL
 *     Analytics API, ONLY when CF_ANALYTICS_TOKEN (+ account/db ids) are set.
 *     Absent or failing → `usage: null`, and the widget shows the growth/storage
 *     view plus a hint to watch the metric via a dashboard alert.
 */
import type { Env } from "../types";
import { memoGet, memoPut } from "./memo";

/** Cloudflare free-tier daily caps. See CAPACITY_MONITORING.md. */
export const D1_CAPS = { rowsRead: 5_000_000, rowsWritten: 100_000, kvWrites: 1_000 } as const;
const STORAGE_CAP_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB free

/**
 * Growth tables and the soft row-count threshold at which a staged optimization
 * lever (D1_OPTIMIZATION.md) should be considered. Mirrors scripts/d1-capacity.mjs.
 */
const GROWTH_THRESHOLDS: Record<string, number> = {
  votes: 1_000_000,
  notifications: 500_000,
  contest_matches: 1_000_000,
  coin_transactions: 1_000_000,
  cron_runs: 100_000,
  blog_posts: 50_000,
  users: 1_000_000,
  follows: 5_000_000,
};

const MEMO_KEY = "admin:capacity";
const MEMO_TTL_SEC = 300; // 5 min — capacity moves slowly; keep the dashboard cheap.

export interface CapacityTable {
  name: string;
  count: number;
  threshold: number;
}
export interface CapacitySnapshot {
  caps: typeof D1_CAPS;
  storageBytes: number | null;
  storageCapBytes: number;
  tables: CapacityTable[];
  /** Today's usage (UTC day) from the Analytics API, or null when unavailable. */
  usage: { rowsRead: number; rowsWritten: number } | null;
  generatedAt: number;
}

/** Today's D1 rows_read / rows_written via the Cloudflare GraphQL Analytics API. */
async function fetchTodayUsage(env: Env): Promise<{ rowsRead: number; rowsWritten: number } | null> {
  const token = env.CF_ANALYTICS_TOKEN;
  const accountTag = env.CF_ACCOUNT_ID;
  const databaseId = env.CF_D1_DATABASE_ID;
  if (!token || !accountTag || !databaseId) return null;

  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  const query =
    "query($tag:String!,$db:String!,$since:Time!){viewer{accounts(filter:{accountTag:$tag}){" +
    "d1AnalyticsAdaptiveGroups(limit:10000,filter:{databaseId:$db,datetime_geq:$since}){sum{rowsRead rowsWritten}}}}}";
  try {
    const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { tag: accountTag, db: databaseId, since: since.toISOString() } }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as any;
    const sum = json?.data?.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups?.[0]?.sum;
    if (!sum) return null;
    return { rowsRead: Number(sum.rowsRead || 0), rowsWritten: Number(sum.rowsWritten || 0) };
  } catch (e) {
    console.error("[capacity] analytics fetch failed (continuing without usage)", e);
    return null;
  }
}

/**
 * Build the capacity snapshot. Memoised 5 min. Never throws — a failure to read
 * counts still returns the caps + whatever usage the analytics call produced.
 */
export async function computeCapacity(env: Env): Promise<CapacitySnapshot> {
  const cached = memoGet<CapacitySnapshot>(MEMO_KEY);
  if (cached) return cached;

  const names = Object.keys(GROWTH_THRESHOLDS);
  let tables: CapacityTable[] = [];
  let storageBytes: number | null = null;
  try {
    // One statement for all counts; `meta.size_after` gives the DB file size.
    const sql = "SELECT " + names.map((t) => `(SELECT COUNT(*) FROM ${t}) AS ${t}`).join(", ") + ";";
    const res = await env.DB.prepare(sql).all<Record<string, number>>();
    const row = res.results?.[0] ?? {};
    storageBytes = (res.meta as any)?.size_after ?? null;
    tables = names.map((name) => ({ name, count: Number(row[name] ?? 0), threshold: GROWTH_THRESHOLDS[name] }));
  } catch (e) {
    console.error("[capacity] count sweep failed", e);
    tables = names.map((name) => ({ name, count: 0, threshold: GROWTH_THRESHOLDS[name] }));
  }

  const usage = await fetchTodayUsage(env);

  const snapshot: CapacitySnapshot = {
    caps: D1_CAPS,
    storageBytes,
    storageCapBytes: STORAGE_CAP_BYTES,
    tables,
    usage,
    generatedAt: Date.now(),
  };
  memoPut(MEMO_KEY, snapshot, MEMO_TTL_SEC);
  return snapshot;
}
