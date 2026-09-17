#!/usr/bin/env node
/**
 * D1 / KV free-tier CAPACITY REPORT for the TopHunt Worker.
 *
 * One command to answer "how close are we to a Cloudflare free-tier wall, and
 * which one hits first?" — see CAPACITY_MONITORING.md for the full runbook.
 *
 *   node scripts/d1-capacity.mjs            # prod DB (tophunt-db)
 *   node scripts/d1-capacity.mjs <db-name>
 *
 * Requires wrangler auth (CLOUDFLARE_API_TOKEN in CI, or `wrangler login`).
 *
 * It reads:
 *   - `wrangler d1 insights` — top queries by rows read/written over the last day
 *   - a single COUNT(*) sweep of the growth tables + the DB file size
 * and prints each against its cap / soft-threshold with a %-used bar, so a
 * regression shows up as a number long before it becomes a 429.
 *
 * NOTE ON EXACTNESS: `d1 insights` reports per-query totals over a rolling
 * window, so the daily rows_read/written here is the SUM OF THE TOP queries —
 * a close lower bound, not the billed total. Cloudflare's own usage alerts
 * (CAPACITY_MONITORING.md Part 1) remain the source of truth for billing; this
 * script is the "which query / which table" diagnostic next to them.
 */
import { execFileSync } from "node:child_process";

const DB = process.argv[2] || "tophunt-db";

// Free-tier daily caps (see CAPACITY_MONITORING.md §caps).
const CAPS = {
  rowsRead: 5_000_000,
  rowsWritten: 100_000,
  // KV writes (1,000/day) is the scarcest free quota, but it is a Workers-KV
  // metric, not a D1 one, so it is not derivable from `d1 insights`. Watched via
  // the Cloudflare dashboard alert (Part 1). Shown here as a reminder only.
  kvWrites: 1_000,
};

// Soft row-count thresholds — the point at which a table's scans/counts start to
// matter and a staged lever (D1_OPTIMIZATION.md) should be considered.
const TABLE_WATCH = {
  votes: 1_000_000, // -> maintained counters (Type 3)
  notifications: 500_000, // -> per-user notification Durable Object (fan-out)
  contest_matches: 1_000_000,
  coin_transactions: 1_000_000,
  cron_runs: 100_000, // -> shorten retention / upsert-per-job
  blog_posts: 50_000, // fixed archive; only matters if it grows a lot
  users: 1_000_000,
  follows: 5_000_000,
};

const D1_STORAGE_CAP_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB free

function wrangler(args) {
  return execFileSync("npx", ["wrangler", ...args], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** wrangler prints a banner before the JSON; slice from the first bracket. */
function parseJson(out) {
  const i = Math.min(...["[", "{"].map((c) => (out.indexOf(c) < 0 ? Infinity : out.indexOf(c))));
  return JSON.parse(out.slice(i));
}

function bar(pct) {
  const n = Math.max(0, Math.min(20, Math.round((pct / 100) * 20)));
  const flag = pct >= 90 ? "🔴" : pct >= 70 ? "🟠" : "🟢";
  return `${flag} [${"█".repeat(n)}${"·".repeat(20 - n)}] ${pct.toFixed(1)}%`;
}

const fmt = (n) => Number(n).toLocaleString("en-US");

async function main() {
  console.log(`\n=== D1 capacity report — ${DB} — ${new Date().toISOString()} ===\n`);

  // 1) Usage from insights (last 1 day).
  let insights = [];
  try {
    insights = parseJson(wrangler(["d1", "insights", DB, "--sort-by", "reads", "--limit", "8", "--json"]));
  } catch (e) {
    console.error("Could not read d1 insights (auth? experimental flag?):", e.message);
  }
  const totalRead = insights.reduce((s, q) => s + (q.totalRowsRead || 0), 0);
  const totalWritten = insights.reduce((s, q) => s + (q.totalRowsWritten || 0), 0);

  console.log("USAGE vs daily caps (sum of top queries over ~1 day — lower bound):");
  console.log(`  rows_read    ${fmt(totalRead)} / ${fmt(CAPS.rowsRead)}   ${bar((totalRead / CAPS.rowsRead) * 100)}`);
  console.log(`  rows_written ${fmt(totalWritten)} / ${fmt(CAPS.rowsWritten)}   ${bar((totalWritten / CAPS.rowsWritten) * 100)}`);
  console.log(`  kv_writes    (dashboard-only) cap ${fmt(CAPS.kvWrites)}/day — the first free wall; watch via CF alert`);

  console.log("\nTOP rows_read queries (last 1 day):");
  for (const q of insights.slice(0, 6)) {
    const query = q.query.replace(/\s+/g, " ").slice(0, 62);
    console.log(`  ${fmt(q.totalRowsRead || 0).padStart(11)}  x${String(q.numberOfTimesRun || 0).padEnd(5)} ${query}`);
  }

  // 2) Growth-table counts + DB size.
  const tables = Object.keys(TABLE_WATCH);
  const countSql =
    "SELECT " + tables.map((t) => `(SELECT COUNT(*) FROM ${t}) AS ${t}`).join(", ") + ";";
  let counts = {};
  let sizeBytes = null;
  try {
    const res = parseJson(wrangler(["d1", "execute", DB, "--remote", "--json", "--command", countSql]));
    counts = res[0]?.results?.[0] ?? {};
    sizeBytes = res[0]?.meta?.size_after ?? null;
  } catch (e) {
    console.error("Could not read table counts:", e.message);
  }

  console.log("\nGROWTH tables vs soft thresholds (staged lever triggers):");
  for (const t of tables) {
    if (counts[t] == null) continue;
    const pct = (counts[t] / TABLE_WATCH[t]) * 100;
    console.log(`  ${t.padEnd(18)} ${fmt(counts[t]).padStart(12)} / ${fmt(TABLE_WATCH[t]).padStart(12)}   ${bar(pct)}`);
  }

  if (sizeBytes != null) {
    const pct = (sizeBytes / D1_STORAGE_CAP_BYTES) * 100;
    const mb = (sizeBytes / 1024 / 1024).toFixed(1);
    console.log(`\nSTORAGE  ${mb} MB / 5120 MB   ${bar(pct)}`);
  }

  console.log("\nAt 70% of any bar: pull the matching lever in D1_OPTIMIZATION.md.");
  console.log("At 70% kv_writes or ~1,500 users: flip SCALE_TIER=\"paid\".\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
