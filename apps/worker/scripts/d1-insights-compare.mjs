#!/usr/bin/env node
/**
 * Before/after D1 Insights comparison — the measurement step for migration 0059
 * and the other query changes in CACHE_POLICY.md.
 *
 *   # 1. BEFORE deploying (or right now, for the current build):
 *   node scripts/d1-insights-compare.mjs snapshot before.json [--period 1d]
 *   # 2. deploy, wait at least one full period, then:
 *   node scripts/d1-insights-compare.mjs snapshot after.json [--period 1d]
 *   # 3. compare:
 *   node scripts/d1-insights-compare.mjs compare before.json after.json
 *
 * `snapshot` needs wrangler auth (`wrangler login`, or CLOUDFLARE_API_TOKEN in CI).
 * `compare` is offline.
 *
 * Queries are grouped into FAMILIES by normalising their SQL (literals, `?`
 * placeholders and IN-lists collapsed), so the same statement with different
 * bound values compares as one line. The headline column is rows read PER RUN:
 * totals move with traffic, per-run cost is what an index changes.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const DB = process.env.D1_DB || "tophunt-db";

/** Collapse a statement to its shape. Exported for tests. */
export function queryFamily(sql) {
  return String(sql || "")
    .replace(/\s+/g, " ")
    .replace(/'(?:[^']|'')*'/g, "?")
    .replace(/\b\d+(\.\d+)?\b/g, "?")
    .replace(/\(\s*\?(\s*,\s*\?)*\s*\)/g, "(?…)")
    .trim()
    .toLowerCase();
}

/** The families this audit changed, and what "better" means for each. */
export const WATCHED = [
  { label: "/read/matches recent page", match: /from "contest_matches".*where .*"status" = \?.*order by .*"created_at" desc/ },
  { label: "comment thread page", match: /from "(match|post)_comments".*order by .*"created_at" desc, .*"id" desc/ },
  { label: "notifications hard prune", match: /delete from notifications where id in \(select id from notifications where created_at < \? limit/ },
  { label: "blog view count", match: /update (blog_posts|"blog_posts") set .*view_count/ },
  { label: "profile following list", match: /select "following_id" from "follows" where "follows"."follower_id" = \?/ },
  { label: "notification insert", match: /insert into "notifications"/ },
];

/** Aggregate raw insights rows into families. Exported for tests. */
export function aggregate(rows) {
  const out = new Map();
  for (const r of rows || []) {
    const fam = queryFamily(r.query);
    const cur = out.get(fam) || { family: fam, runs: 0, rowsRead: 0, rowsWritten: 0 };
    cur.runs += Number(r.numberOfTimesRun || 0);
    cur.rowsRead += Number(r.totalRowsRead || 0);
    cur.rowsWritten += Number(r.totalRowsWritten || 0);
    out.set(fam, cur);
  }
  return out;
}

const perRun = (f) => (f && f.runs ? f.rowsRead / f.runs : null);
const fmt = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US", { maximumFractionDigits: 1 }));

/** The comparison table as lines. Exported for tests. */
export function compareReport(before, after) {
  const a = aggregate(before);
  const b = aggregate(after);
  const lines = [];
  const pick = (m, re) => {
    let acc = null;
    for (const f of m.values()) {
      if (!re.test(f.family)) continue;
      acc = acc || { runs: 0, rowsRead: 0, rowsWritten: 0 };
      acc.runs += f.runs;
      acc.rowsRead += f.rowsRead;
      acc.rowsWritten += f.rowsWritten;
    }
    return acc;
  };
  lines.push("family".padEnd(30) + "rows/run before".padStart(17) + "rows/run after".padStart(16) + "runs b→a".padStart(18) + "writes b→a".padStart(18));
  for (const w of WATCHED) {
    const x = pick(a, w.match);
    const y = pick(b, w.match);
    lines.push(
      w.label.padEnd(30) +
        fmt(perRun(x)).padStart(17) +
        fmt(perRun(y)).padStart(16) +
        `${fmt(x?.runs)}→${fmt(y?.runs)}`.padStart(18) +
        `${fmt(x?.rowsWritten)}→${fmt(y?.rowsWritten)}`.padStart(18),
    );
  }
  const tot = (m) => [...m.values()].reduce((s, f) => s + f.rowsRead, 0);
  const totW = (m) => [...m.values()].reduce((s, f) => s + f.rowsWritten, 0);
  lines.push("");
  lines.push(`total rows_read (top queries): ${fmt(tot(a))} → ${fmt(tot(b))}`);
  lines.push(`total rows_written (top queries): ${fmt(totW(a))} → ${fmt(totW(b))}`);
  lines.push("Totals move with traffic; compare rows/run, and treat both as lower bounds (top-N only).");
  return lines;
}

function snapshot(file, period) {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "insights", DB, "--sort-by", "reads", "--limit", "100", "--time-period", period, "--json"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
  );
  const i = out.indexOf("[");
  const rows = JSON.parse(out.slice(i));
  fs.writeFileSync(file, JSON.stringify({ takenAt: new Date().toISOString(), period, db: DB, rows }, null, 2));
  console.log(`saved ${rows.length} query families → ${file}`);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const [cmd, x, y] = process.argv.slice(2);
  const pIdx = process.argv.indexOf("--period");
  const period = pIdx > 0 ? process.argv[pIdx + 1] : "1d";
  if (cmd === "snapshot" && x) snapshot(x, period);
  else if (cmd === "compare" && x && y) {
    const before = JSON.parse(fs.readFileSync(x, "utf8"));
    const after = JSON.parse(fs.readFileSync(y, "utf8"));
    console.log(`before: ${before.takenAt} (${before.period})   after: ${after.takenAt} (${after.period})\n`);
    for (const l of compareReport(before.rows, after.rows)) console.log(l);
  } else {
    console.error("usage: d1-insights-compare.mjs snapshot <file> [--period 1d] | compare <before> <after>");
    process.exit(2);
  }
}
