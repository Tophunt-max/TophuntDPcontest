#!/usr/bin/env node
/**
 * Per-route shared-cache hit ratio and latency, from the Worker's request log line.
 *
 * Every request logs one JSON line ({ path, status, ms, edgeCache? }; see
 * src/index.ts). This reads either:
 *   - `wrangler tail tophunt-api --format json` output (one event per line, the log
 *     line inside `logs[].message[0]`), or
 *   - a Workers Logs export / plain file of those JSON request lines.
 *
 *   npx wrangler tail tophunt-api --format json --sampling-rate 0.2 > tail.jsonl   # Ctrl-C after a while
 *   node scripts/cache-hit-report.mjs tail.jsonl
 *   # or: npx wrangler tail tophunt-api --format json | node scripts/cache-hit-report.mjs -
 *
 * Paths are grouped (ids → :id) so `/read/matches/abc` and `/read/matches/def` are
 * one row. `edgeCache` values: hit (Cache API) · kv · miss (computed + stored) ·
 * skip (computed, uncacheable answer) · bypass (no Cache API, e.g. *.workers.dev).
 * hit% = (hit + kv) / (hit + kv + miss). A sampled tail gives ratios, not totals.
 */
import fs from "node:fs";
import readline from "node:readline";

/** `/read/matches/AbC123xyz` → `/read/matches/:id`. Exported for tests. */
export function routeOf(path) {
  return String(path || "")
    .split("?")[0]
    .split("/")
    .map((seg, i) => (i > 2 && /^[A-Za-z0-9_-]{6,}$/.test(seg) && /\d/.test(seg) ? ":id" : seg))
    .join("/");
}

/** Pull request-log records out of one input line (tail event or raw line). Exported for tests. */
export function recordsFromLine(line) {
  const out = [];
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return out;
  }
  const consider = (v) => {
    let r = v;
    if (typeof v === "string") {
      try {
        r = JSON.parse(v);
      } catch {
        return;
      }
    }
    if (r && typeof r === "object" && typeof r.path === "string" && typeof r.ms === "number") out.push(r);
  };
  if (Array.isArray(obj?.logs)) {
    for (const l of obj.logs) for (const m of l?.message || []) consider(m);
  } else {
    consider(obj);
  }
  return out;
}

function pct(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

/** Aggregate records into per-route rows. Exported for tests. */
export function summarise(records) {
  const by = new Map();
  for (const r of records) {
    const route = routeOf(r.path);
    const s = by.get(route) || { route, n: 0, errors: 0, ms: [], hit: 0, kv: 0, miss: 0, skip: 0, bypass: 0 };
    s.n += 1;
    if (r.status >= 500) s.errors += 1;
    s.ms.push(r.ms);
    if (r.edgeCache && r.edgeCache in s) s[r.edgeCache] += 1;
    by.set(route, s);
  }
  return [...by.values()]
    .map((s) => {
      const sorted = s.ms.sort((a, b) => a - b);
      const lookups = s.hit + s.kv + s.miss;
      return {
        route: s.route,
        requests: s.n,
        hitRatio: lookups ? (s.hit + s.kv) / lookups : null,
        hit: s.hit, kv: s.kv, miss: s.miss, skip: s.skip, bypass: s.bypass,
        p50: pct(sorted, 50), p95: pct(sorted, 95),
        errorRate: s.n ? s.errors / s.n : 0,
      };
    })
    .sort((a, b) => b.requests - a.requests);
}

async function main(file) {
  const input = file === "-" || !file ? process.stdin : fs.createReadStream(file);
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const records = [];
  for await (const line of rl) records.push(...recordsFromLine(line));
  const rows = summarise(records);
  console.log(`${records.length} request lines\n`);
  console.log("route".padEnd(42) + "reqs".padStart(7) + "hit%".padStart(7) + "  hit/kv/miss/skip/bypass".padEnd(26) + "p50".padStart(6) + "p95".padStart(6) + "5xx%".padStart(6));
  for (const r of rows.slice(0, 40)) {
    console.log(
      r.route.slice(0, 41).padEnd(42) +
        String(r.requests).padStart(7) +
        (r.hitRatio == null ? "—" : `${(r.hitRatio * 100).toFixed(0)}%`).padStart(7) +
        `  ${r.hit}/${r.kv}/${r.miss}/${r.skip}/${r.bypass}`.padEnd(26) +
        String(r.p50 ?? "—").padStart(6) +
        String(r.p95 ?? "—").padStart(6) +
        `${(r.errorRate * 100).toFixed(1)}`.padStart(6),
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv[2]);
