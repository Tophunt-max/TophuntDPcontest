#!/usr/bin/env node
/**
 * Repeatable local benchmark for the hot / growing D1 query shapes.
 *
 *   node scripts/bench-hot-queries.mjs                # all migrations
 *   node scripts/bench-hot-queries.mjs --without 0059 # baseline: skip a migration
 *   node scripts/bench-hot-queries.mjs --scale 2      # double every seeded table
 *   node scripts/bench-hot-queries.mjs --analyze      # plan WITH sqlite_stat1 statistics
 *
 * Plans differ with and without ANALYZE statistics (e.g. SQLite can skip-scan
 * idx_notif_recipient for a bare created_at range once it knows recipient_id has
 * few distinct values). Whether production D1 holds statistics depends on whether
 * `PRAGMA optimize` / ANALYZE has been run there, so report BOTH.
 *
 * Builds an in-memory SQLite database from migrations/*.sql (the same files D1
 * applies), seeds synthetic rows, and reports for each query: its plan, the
 * median wall time over RUNS executions, and how many rows its WHERE clause
 * matches. When the plan says "USE TEMP B-TREE" or "SCAN", every one of those
 * matched rows is read to return the page — that is what D1 bills as rows_read.
 * With an ORDER-BY-covering index, reads stop near LIMIT instead.
 *
 * This is a LOCAL proxy, not a production measurement: Node's bundled SQLite is
 * not D1 and the data is synthetic. Use it to compare plans/ratios between two
 * schema versions; use `wrangler d1 insights` for real rows_read figures.
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const without = args.includes('--without') ? args[args.indexOf('--without') + 1] : null;
const scale = args.includes('--scale') ? Number(args[args.indexOf('--scale') + 1]) || 1 : 1;
const analyze = args.includes('--analyze');
const RUNS = 25;

const dir = path.join(import.meta.dirname, '..', 'migrations');
const db = new DatabaseSync(':memory:');
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
  if (without && f.startsWith(without)) continue;
  db.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
}

// --- seed -------------------------------------------------------------------
const N = {
  completedMatches: 20_000 * scale,
  activeMatches: 400 * scale,
  commentsOnHotMatch: 5_000 * scale,
  notifications: 200_000 * scale,
};
const now = Date.now();
const DAY = 86_400_000;
db.exec('BEGIN');
{
  const ins = db.prepare(
    "INSERT INTO contest_matches (id, status, type, user_a, user_b, created_at, expires_at) VALUES (?, ?, 'photo', '{}', '{}', ?, ?)",
  );
  for (let i = 0; i < N.completedMatches; i++) ins.run(`c${i}`, 'completed', now - i * 60_000, now - i * 60_000 + DAY);
  for (let i = 0; i < N.activeMatches; i++) ins.run(`a${i}`, 'active', now - i * 30_000, now + DAY);
  const com = db.prepare("INSERT INTO match_comments (id, match_id, user_id, text, created_at) VALUES (?, ?, 'u', 'x', ?)");
  for (let i = 0; i < N.commentsOnHotMatch; i++) com.run(`k${i}`, 'hot', now - i * 1000);
  // Background threads on other battles, so match_id is selective (as in production).
  for (let i = 0; i < 20_000 * scale; i++) com.run(`o${i}`, `c${i % 4000}`, now - i * 1000);
  const notif = db.prepare(
    "INSERT INTO notifications (id, recipient_id, title, body, type, read, seen, created_at) VALUES (?, ?, 't', 'b', 'follow', ?, ?, ?)",
  );
  // All younger than the 180-day hard-retention cutoff: the common steady state,
  // where the prune finds (almost) nothing to delete.
  for (let i = 0; i < N.notifications; i++) {
    notif.run(`n${i}`, `u${i % 2000}`, i % 3 === 0 ? 1 : 0, i % 2, now - (i % 170) * DAY);
  }
}
db.exec('COMMIT');
if (analyze) db.exec('ANALYZE');

// --- queries ----------------------------------------------------------------
const hardCutoff = now - 180 * DAY;
const queries = [
  {
    name: '/read/matches recent (active)',
    sql: "SELECT * FROM contest_matches WHERE status = 'active' ORDER BY created_at DESC LIMIT 30",
    matched: "SELECT count(*) n FROM contest_matches WHERE status = 'active'",
  },
  {
    name: '/read/matches recent (completed, page 5)',
    sql: `SELECT * FROM contest_matches WHERE status = 'completed' AND created_at < ${now - 120 * 60_000} ORDER BY created_at DESC LIMIT 30`,
    matched: `SELECT count(*) n FROM contest_matches WHERE status = 'completed' AND created_at < ${now - 120 * 60_000}`,
  },
  {
    name: '/read/comments hot battle',
    sql: "SELECT * FROM match_comments WHERE match_id = 'hot' ORDER BY created_at DESC, id DESC LIMIT 21",
    matched: "SELECT count(*) n FROM match_comments WHERE match_id = 'hot'",
  },
  {
    name: 'pruneNotifications hard pass (select)',
    sql: `SELECT id FROM notifications WHERE created_at < ${hardCutoff} LIMIT 500`,
    matched: 'SELECT count(*) n FROM notifications',
    note: 'steady state: nothing old enough to delete, so a full scan reads every row to find none',
  },
];

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

console.log(`schema: ${without ? `all migrations EXCEPT ${without}` : 'all migrations'} · scale ${scale} · stats ${analyze ? 'ANALYZE' : 'none'}`);
console.log(`seeded: ${JSON.stringify(N)}\n`);
for (const q of queries) {
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).all().map((r) => r.detail).join(' | ');
  const stmt = db.prepare(q.sql);
  const times = [];
  for (let i = 0; i < RUNS; i++) {
    const t = process.hrtime.bigint();
    stmt.all();
    times.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  const matched = db.prepare(q.matched).get().n;
  // A temp-sort or an index-less table scan reads every matched row; a skip-scan
  // (ANY(...)) reads one index range per distinct leading value.
  const readsAll = /TEMP B-TREE/.test(plan) || /(^|\| )SCAN \w+( \||$)/.test(plan);
  const skip = /ANY\(/.test(plan);
  console.log(`• ${q.name}`);
  console.log(`    plan:    ${plan}`);
  console.log(`    median:  ${median(times).toFixed(3)} ms over ${RUNS} runs`);
  const verdict = readsAll ? '  ← all read per execution' : skip ? '  (skip-scan: one probe per distinct leading key)' : '  (index stops near LIMIT)';
  console.log(`    rows matched by WHERE: ${matched}${verdict}`);
  if (q.note) console.log(`    note:    ${q.note}`);
}
