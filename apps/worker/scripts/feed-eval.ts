/**
 * Offline evaluation of For You ranking weights (lib/feedEval.ts).
 *
 *   npm run feed:eval -- build   --local|--remote [--days 14] [--viewers 200] [--horizon 24] [--out feed-eval.json]
 *   npm run feed:eval -- compare --data feed-eval.json --a defaults|<weights.json>|'<json>' --b <weights.json>|'<json>'
 *
 * `build` only runs SELECT statements through `wrangler d1 execute` (it refuses
 * anything else), against the local database or, with --remote, production. Use
 * --remote off-peak; a restored backup (docs/RUNBOOK.md §5) loaded locally is the
 * safest source. The dataset holds uids and battle ids: keep the file private and
 * delete it after use.
 *
 * `compare` needs no database. It prints mean NDCG@8/16, recall@8/16, MRR, creator
 * diversity and the age of the top 8 for both weight sets, the difference, and
 * per-snapshot wins/losses. Exit code 0 always; read the numbers.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { compareWeights, type EvalDataset, type EvalMatch, type EvalSnapshot } from "../src/lib/feedEval";
import { FEED_DEFAULT_WEIGHTS } from "../src/lib/feedWeights";

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name: string, fallback?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const flag = (name: string) => args.includes(`--${name}`);

const H = 3_600_000;
const D = 24 * H;
const SAFE_ID = /^[A-Za-z0-9_:.-]{1,128}$/;
const POOL_ACTIVE = 150;
const POOL_RESULTS = 40;
const LOOKBACK = 500;

function query<T = any>(sql: string, remote: boolean): T[] {
  if (!/^\s*select\b/i.test(sql) || /;\s*\S/.test(sql)) throw new Error(`refusing a non-SELECT statement: ${sql.slice(0, 60)}`);
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "tophunt-db", remote ? "--remote" : "--local", "--json", "--command", sql],
    { encoding: "utf8", maxBuffer: 512 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"] },
  );
  const parsed = JSON.parse(out);
  return (parsed?.[0]?.results ?? []) as T[];
}

const inList = (ids: string[]) => ids.filter((x) => SAFE_ID.test(x)).map((x) => `'${x}'`).join(",") || "''";
const chunks = <T,>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
const json = (v: unknown) => {
  if (v && typeof v === "object") return v as any;
  try {
    return JSON.parse(String(v));
  } catch {
    return null;
  }
};

/** Timestamps per key, sorted, for "how many before t" lookups. */
function timeline(rows: Array<{ k: string; t: number }>): Map<string, number[]> {
  const m = new Map<string, number[]>();
  for (const r of rows) {
    const a = m.get(r.k) ?? [];
    a.push(Number(r.t));
    m.set(r.k, a);
  }
  for (const a of m.values()) a.sort((x, y) => x - y);
  return m;
}
function countBefore(sorted: number[] | undefined, t: number): number {
  if (!sorted) return 0;
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function build() {
  const remote = flag("remote");
  if (!remote && !flag("local")) throw new Error("say --local or --remote");
  const days = Math.min(Math.max(Number(opt("days", "14")), 1), 90);
  const nViewers = Math.min(Math.max(Number(opt("viewers", "200")), 1), 2000);
  const horizonH = Math.min(Math.max(Number(opt("horizon", "24")), 1), 72);
  const out = opt("out", "feed-eval.json")!;
  const now = Date.now();
  const from = now - days * D;
  console.error(`[feed-eval] ${remote ? "REMOTE" : "local"} D1, ${days} days, up to ${nViewers} viewers, horizon ${horizonH} h`);

  const matchRows = query(
    `SELECT id, type, status, entry_fee AS entryFee, created_at AS createdAt, activated_at AS activatedAt, expires_at AS expiresAt, share_count AS shareCount, user_a AS userA, user_b AS userB
       FROM contest_matches
      WHERE created_at <= ${now} AND (expires_at IS NULL OR expires_at >= ${from - D})
        AND status IN ('active','completed') AND user_b IS NOT NULL
        AND COALESCE(is_private, 0) = 0 AND moderation_hold_at IS NULL
      ORDER BY created_at DESC LIMIT 20000`,
    remote,
  );
  const matches = matchRows
    .map((r: any) => ({
      id: String(r.id),
      type: r.type,
      createdAt: Number(r.createdAt),
      activatedAt: r.activatedAt != null ? Number(r.activatedAt) : null,
      expiresAt: r.expiresAt != null ? Number(r.expiresAt) : null,
      entryFee: Number(r.entryFee) || 0,
      shareCount: 0,
      userA: json(r.userA)?.uid ? { uid: String(json(r.userA).uid) } : null,
      userB: json(r.userB)?.uid ? { uid: String(json(r.userB).uid) } : null,
    }))
    .filter((m) => m.userA && m.userB);
  const matchIds = matches.map((m) => m.id);
  console.error(`[feed-eval] ${matches.length} battles`);

  // Engagement timelines per battle, so counts are taken as they stood at `at`.
  const voteT: Array<{ k: string; t: number }> = [];
  const likeT: Array<{ k: string; t: number }> = [];
  const commentT: Array<{ k: string; t: number }> = [];
  for (const ids of chunks(matchIds, 400)) {
    voteT.push(...query(`SELECT match_id AS k, created_at AS t FROM votes WHERE match_id IN (${inList(ids)})`, remote));
    likeT.push(...query(`SELECT match_id AS k, created_at AS t FROM match_likes WHERE match_id IN (${inList(ids)})`, remote));
    commentT.push(...query(`SELECT match_id AS k, created_at AS t FROM match_comments WHERE match_id IN (${inList(ids)})`, remote));
  }
  const votesBy = timeline(voteT);
  const likesBy = timeline(likeT);
  const commentsBy = timeline(commentT);

  const viewers = query<{ uid: string }>(
    `SELECT voter_uid AS uid FROM votes WHERE created_at >= ${from} GROUP BY voter_uid HAVING COUNT(*) >= 3 ORDER BY RANDOM() LIMIT ${nViewers}`,
    remote,
  )
    .map((r) => String(r.uid))
    .filter((u) => SAFE_ID.test(u));
  console.error(`[feed-eval] ${viewers.length} viewers`);

  const byViewer = <T,>(rows: T[], key: (r: T) => string) => {
    const m = new Map<string, T[]>();
    for (const r of rows) {
      const k = key(r);
      m.set(k, [...(m.get(k) ?? []), r]);
    }
    return m;
  };
  const vVotes: any[] = [];
  const vLikes: any[] = [];
  const vComments: any[] = [];
  const vFollows: any[] = [];
  const vVisits: any[] = [];
  const vDismiss: any[] = [];
  for (const ids of chunks(viewers, 100)) {
    const L = inList(ids);
    vVotes.push(...query(`SELECT voter_uid AS u, match_id AS m, voted_for_uid AS f, created_at AS t FROM votes WHERE voter_uid IN (${L}) AND created_at >= ${from - 60 * D}`, remote));
    vLikes.push(...query(`SELECT user_id AS u, match_id AS m, created_at AS t FROM match_likes WHERE user_id IN (${L}) AND created_at >= ${from}`, remote));
    vComments.push(...query(`SELECT user_id AS u, match_id AS m, created_at AS t FROM match_comments WHERE user_id IN (${L}) AND created_at >= ${from}`, remote));
    vFollows.push(...query(`SELECT follower_id AS u, following_id AS f, created_at AS t FROM follows WHERE follower_id IN (${L})`, remote));
    vVisits.push(...query(`SELECT visitor_id AS u, user_id AS f, created_at AS t FROM profile_visits WHERE visitor_id IN (${L}) AND created_at >= ${from - 60 * D}`, remote));
    vDismiss.push(...query(`SELECT viewer_uid AS u, match_id AS m, creator_a AS a, creator_b AS b, created_at AS t FROM feed_dismissals WHERE viewer_uid IN (${L})`, remote));
  }
  const votesOf = byViewer(vVotes, (r) => r.u);
  const likesOf = byViewer(vLikes, (r) => r.u);
  const commentsOf = byViewer(vComments, (r) => r.u);
  const followsOf = byViewer(vFollows, (r) => r.u);
  const visitsOf = byViewer(vVisits, (r) => r.u);
  const dismissOf = byViewer(vDismiss, (r) => r.u);

  const creatorUids = [...new Set(matches.flatMap((m) => [m.userA!.uid, m.userB!.uid]))];
  const creators: Record<string, { createdAt: number; followersCount: number }> = {};
  for (const ids of chunks(creatorUids, 400)) {
    for (const r of query(`SELECT uid, created_at AS c, COALESCE(followers_count, 0) AS f FROM users WHERE uid IN (${inList(ids)})`, remote)) {
      creators[String(r.uid)] = { createdAt: Number(r.c) || 0, followersCount: Number(r.f) || 0 };
    }
  }

  const snapshots: EvalSnapshot[] = [];
  for (const viewer of viewers) {
    // Up to 3 sessions per viewer: a vote in the window, at least 2 h after the last pick.
    const times = (votesOf.get(viewer) ?? []).map((r) => Number(r.t)).filter((t) => t >= from && t + horizonH * H <= now).sort((a, b) => a - b);
    const picks: number[] = [];
    for (const t of times) if (!picks.length || t - picks[picks.length - 1] >= 2 * H) picks.push(t);
    for (const voteAt of picks.slice(-3)) {
      const at = voteAt - 60_000;
      const live = matches
        .filter((m) => Number(m.activatedAt || m.createdAt) <= at && (m.expiresAt == null || m.expiresAt > at))
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, POOL_ACTIVE);
      const results = matches
        .filter((m) => m.expiresAt != null && m.expiresAt <= at && m.expiresAt > at - D)
        .sort((a, b) => (b.expiresAt ?? 0) - (a.expiresAt ?? 0))
        .slice(0, POOL_RESULTS);
      const pool: EvalMatch[] = [
        ...live.map((m) => ({ ...m, status: "active" as const })),
        ...results.map((m) => ({ ...m, status: "completed" as const })),
      ].map((m) => ({
        ...m,
        totalVotes: countBefore(votesBy.get(m.id), at),
        likeCount: countBefore(likesBy.get(m.id), at),
        commentCount: countBefore(commentsBy.get(m.id), at),
      }));
      const inPool = new Set(pool.map((m) => m.id));
      const before = (rows: any[] | undefined) => (rows ?? []).filter((r) => Number(r.t) < at).sort((a, b) => Number(b.t) - Number(a.t));
      const priorVotes = before(votesOf.get(viewer)).slice(0, LOOKBACK);
      const priorDismiss = before(dismissOf.get(viewer)).slice(0, 200);
      const outcomes: Record<string, number> = {};
      const end = at + horizonH * H;
      const gain = (rows: any[] | undefined, g: number) => {
        for (const r of rows ?? []) {
          const t = Number(r.t);
          if (t > at && t <= end && inPool.has(r.m)) outcomes[r.m] = Math.max(outcomes[r.m] ?? 0, g);
        }
      };
      gain(votesOf.get(viewer), 1);
      gain(likesOf.get(viewer), 1);
      gain(commentsOf.get(viewer), 2);
      const poolCreators: EvalSnapshot["creators"] = {};
      for (const m of pool) for (const u of [m.userA?.uid, m.userB?.uid]) if (u && creators[u]) poolCreators[u] = creators[u];
      snapshots.push({
        viewer,
        at,
        pool,
        creators: poolCreators,
        signals: {
          follows: before(followsOf.get(viewer)).map((r) => String(r.f)),
          votedFor: priorVotes.map((r) => String(r.f)),
          votedMatches: priorVotes.map((r) => String(r.m)),
          visited: before(visitsOf.get(viewer)).slice(0, LOOKBACK).map((r) => String(r.f)),
          dismissedCreators: priorDismiss.flatMap((r) => [r.a, r.b]).filter(Boolean).map(String),
          dismissedMatches: priorDismiss.map((r) => String(r.m)),
        },
        outcomes,
      });
    }
  }
  const data: EvalDataset = { version: 1, builtAt: now, source: remote ? "remote" : "local", horizonHours: horizonH, snapshots };
  writeFileSync(out, JSON.stringify(data));
  console.error(`[feed-eval] wrote ${snapshots.length} snapshots to ${out} (contains uids: keep it private)`);
}

function loadWeights(v: string | undefined): unknown {
  if (!v || v === "defaults") return FEED_DEFAULT_WEIGHTS;
  if (v.trim().startsWith("{")) return JSON.parse(v);
  return JSON.parse(readFileSync(v, "utf8"));
}

function compare() {
  const file = opt("data");
  if (!file) throw new Error("--data <file> is required");
  const data = JSON.parse(readFileSync(file, "utf8")) as EvalDataset;
  const r = compareWeights(data, loadWeights(opt("a", "defaults")), loadWeights(opt("b")));
  const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
  const rows: Array<[string, keyof typeof r.meanA, (x: number) => string]> = [
    ["NDCG@8", "ndcg8", pct],
    ["NDCG@16", "ndcg16", pct],
    ["Recall@8", "recall8", pct],
    ["Recall@16", "recall16", pct],
    ["MRR", "mrr", (x) => x.toFixed(4)],
    ["Creator diversity top 8", "diversity8", pct],
    ["Mean age top 8 (h)", "ageH8", (x) => x.toFixed(1)],
  ];
  console.log(`A ${r.versionA}  vs  B ${r.versionB}`);
  console.log(`snapshots scored ${r.scored}, skipped ${r.skipped} (no outcome in the pool)\n`);
  console.log(`${"metric".padEnd(26)}${"A".padStart(10)}${"B".padStart(10)}${"B - A".padStart(10)}`);
  for (const [label, k, f] of rows) {
    console.log(`${label.padEnd(26)}${f(r.meanA[k]).padStart(10)}${f(r.meanB[k]).padStart(10)}${f(r.delta[k]).padStart(10)}`);
  }
  console.log(`\nNDCG@16 per snapshot: B better ${r.wins}, worse ${r.losses}, equal ${r.ties}`);
  console.log(`\nLimits:\n- ${r.limits.join("\n- ")}`);
}

try {
  if (cmd === "build") build();
  else if (cmd === "compare") compare();
  else {
    console.error("usage: feed-eval build --local|--remote [--days 14] [--viewers 200] [--horizon 24] [--out file]\n       feed-eval compare --data file --a defaults|<json|file> --b <json|file>");
    process.exit(2);
  }
} catch (e: any) {
  console.error(`[feed-eval] ${e?.message || e}`);
  process.exit(1);
}
