/**
 * Offline evaluation of For You ranking weights (replay harness).
 *
 * Question it answers: "had the feed used weights B instead of A, would the
 * battles people went on to vote on, like or comment on have been higher up?"
 *
 * Input is a dataset of SNAPSHOTS (built by scripts/feed-eval.ts from D1 or a
 * restored backup). Each snapshot is one viewer at one moment `at`:
 *  - `pool`: the battles that were live (or had just finished) at `at`, with
 *    engagement counts as they stood at `at` (so the outcomes below do not leak
 *    into the score);
 *  - `signals`: what the viewer's history was at `at` (follows, votes, visits,
 *    "Not interested");
 *  - `outcomes`: battle id -> gain, for what the viewer engaged with in the next
 *    `horizon` hours (vote/like 1, comment 2; the highest counts).
 * Both weight sets rank every snapshot with the live feed's own code
 * (lib/feedRanking.ts), and the ranks of the outcomes are scored.
 *
 * Known limits, also printed in the report: impression fatigue is unknown
 * offline (no impression log), so `seenPenalty` is not exercised; share counts
 * and reactions have no history, so they are zero; follower counts and
 * moderation holds are today's values; unfollows before `at` cannot be seen. The
 * outcome is "engaged anyway, wherever the feed put it", so the metric favours
 * weights that rank what people already chose, which is the usual bias of
 * replay evaluation; use it to compare weight sets, not as an absolute number.
 */
import { sanitizeFeedWeights, rankingVersion, type FeedWeights } from "./feedWeights";
import { isNewCreatorAt, rankBaseScore, rankForViewer, type ViewerSignals } from "./feedRanking";

export interface EvalMatch {
  id: string;
  type?: string | null;
  status: "active" | "completed";
  entryFee?: number | null;
  createdAt: number;
  activatedAt?: number | null;
  expiresAt?: number | null;
  totalVotes: number;
  likeCount: number;
  commentCount: number;
  shareCount?: number;
  userA: { uid: string } | null;
  userB: { uid: string } | null;
}

export interface EvalSnapshot {
  viewer: string;
  at: number;
  pool: EvalMatch[];
  /** uid -> account creation time and follower count (for the new-creator boost). */
  creators: Record<string, { createdAt: number; followersCount: number }>;
  signals: {
    follows: string[];
    votedFor: string[];
    votedMatches: string[];
    visited: string[];
    dismissedCreators: string[];
    dismissedMatches: string[];
  };
  outcomes: Record<string, number>;
}

export interface EvalDataset {
  version: 1;
  builtAt: number;
  source: string;
  horizonHours: number;
  snapshots: EvalSnapshot[];
}

export interface SnapshotMetrics {
  ndcg8: number;
  ndcg16: number;
  recall8: number;
  recall16: number;
  mrr: number;
  /** Distinct creators in the top 8, divided by the slots' creator count. */
  diversity8: number;
  /** Mean hours since start of the top 8 at `at`. */
  ageH8: number;
}

const METRIC_KEYS: Array<keyof SnapshotMetrics> = ["ndcg8", "ndcg16", "recall8", "recall16", "mrr", "diversity8", "ageH8"];

/** The live feed's order for one snapshot under `w`. */
export function rankSnapshot(snap: EvalSnapshot, w: FeedWeights): string[] {
  const dismissed = new Set(snap.signals.dismissedMatches);
  const pool = snap.pool
    .filter((m) => !dismissed.has(m.id))
    .map((m) => {
      let base = rankBaseScore(m, snap.at, w);
      if (m.status !== "completed" && w.newCreator) {
        const isNew = [m.userA?.uid, m.userB?.uid].some((u) => {
          const c = u ? snap.creators[u] : undefined;
          return !!c && isNewCreatorAt(c.createdAt, c.followersCount, snap.at);
        });
        if (isNew) base += w.newCreator;
      }
      return { ...m, _base: base };
    })
    .sort((a, b) => b._base - a._base);
  const sig: ViewerSignals = {
    follows: new Set(snap.signals.follows),
    votedFor: new Set(snap.signals.votedFor),
    votedMatches: new Set(snap.signals.votedMatches),
    visited: new Set(snap.signals.visited),
    dismissedCreators: new Set(snap.signals.dismissedCreators),
    seen: {},
  };
  return rankForViewer(pool, sig, w).map((m) => m.id);
}

function dcg(gains: number[]): number {
  return gains.reduce((sum, g, i) => sum + (Math.pow(2, g) - 1) / Math.log2(i + 2), 0);
}

/** Ranking metrics for one ordered list against the snapshot's outcomes. */
export function scoreOrder(order: string[], snap: EvalSnapshot): SnapshotMetrics {
  const gainOf = (id: string) => snap.outcomes[id] || 0;
  const relevant = Object.keys(snap.outcomes).filter((id) => snap.outcomes[id] > 0 && order.includes(id));
  const ideal = relevant.map(gainOf).sort((a, b) => b - a);
  const ndcgAt = (k: number) => {
    const best = dcg(ideal.slice(0, k));
    return best > 0 ? dcg(order.slice(0, k).map(gainOf)) / best : 0;
  };
  const recallAt = (k: number) => (relevant.length ? order.slice(0, k).filter((id) => gainOf(id) > 0).length / relevant.length : 0);
  const firstHit = order.findIndex((id) => gainOf(id) > 0);
  const byId = new Map(snap.pool.map((m) => [m.id, m]));
  const top8 = order.slice(0, 8).map((id) => byId.get(id)).filter(Boolean) as EvalMatch[];
  const creators = top8.flatMap((m) => [m.userA?.uid, m.userB?.uid]).filter(Boolean) as string[];
  const ages = top8.map((m) => Math.max(0, (snap.at - Number(m.activatedAt || m.createdAt)) / 3_600_000));
  return {
    ndcg8: ndcgAt(8),
    ndcg16: ndcgAt(16),
    recall8: recallAt(8),
    recall16: recallAt(16),
    mrr: firstHit >= 0 ? 1 / (firstHit + 1) : 0,
    diversity8: creators.length ? new Set(creators).size / creators.length : 0,
    ageH8: ages.length ? ages.reduce((a, b) => a + b, 0) / ages.length : 0,
  };
}

export interface CompareReport {
  versionA: string;
  versionB: string;
  /** Snapshots with at least one outcome in the pool (the rest cannot be scored). */
  scored: number;
  skipped: number;
  meanA: SnapshotMetrics;
  meanB: SnapshotMetrics;
  /** B minus A. */
  delta: SnapshotMetrics;
  /** Per-snapshot NDCG@16: B better / worse / equal. */
  wins: number;
  losses: number;
  ties: number;
  limits: string[];
}

function mean(rows: SnapshotMetrics[]): SnapshotMetrics {
  const out = Object.fromEntries(METRIC_KEYS.map((k) => [k, 0])) as unknown as SnapshotMetrics;
  if (!rows.length) return out;
  for (const r of rows) for (const k of METRIC_KEYS) out[k] += r[k];
  for (const k of METRIC_KEYS) out[k] /= rows.length;
  return out;
}

/** Rank every snapshot with both weight sets and compare. Weights are clamped like the live feed does. */
export function compareWeights(data: EvalDataset, rawA: unknown, rawB: unknown): CompareReport {
  const wA = sanitizeFeedWeights(rawA);
  const wB = sanitizeFeedWeights(rawB);
  const a: SnapshotMetrics[] = [];
  const b: SnapshotMetrics[] = [];
  let skipped = 0;
  let wins = 0;
  let losses = 0;
  let ties = 0;
  for (const snap of data.snapshots) {
    const poolIds = new Set(snap.pool.map((m) => m.id));
    if (!Object.keys(snap.outcomes).some((id) => snap.outcomes[id] > 0 && poolIds.has(id))) {
      skipped++;
      continue;
    }
    const ma = scoreOrder(rankSnapshot(snap, wA), snap);
    const mb = scoreOrder(rankSnapshot(snap, wB), snap);
    a.push(ma);
    b.push(mb);
    const d = mb.ndcg16 - ma.ndcg16;
    if (d > 1e-9) wins++;
    else if (d < -1e-9) losses++;
    else ties++;
  }
  const meanA = mean(a);
  const meanB = mean(b);
  const delta = Object.fromEntries(METRIC_KEYS.map((k) => [k, meanB[k] - meanA[k]])) as unknown as SnapshotMetrics;
  return {
    versionA: rankingVersion(wA),
    versionB: rankingVersion(wB),
    scored: a.length,
    skipped,
    meanA,
    meanB,
    delta,
    wins,
    losses,
    ties,
    limits: [
      "Impression fatigue is not replayed (no impression log), so seenPenalty/seenCap have no effect here.",
      "Share counts and reactions have no history and are zero; follower counts and moderation holds are current values.",
      "Outcomes are what viewers engaged with under the feed they actually saw, which favours weights close to the live ones.",
    ],
  };
}
