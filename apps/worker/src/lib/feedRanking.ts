/**
 * The For You scoring functions, shared by the live feed (routes/read.ts
 * `servePersonalizedFeed`) and the offline evaluation harness (lib/feedEval.ts),
 * so both rank with the same code. Pure: rows, weights and the viewer's signals in,
 * scores out. Rules and formulas: docs/RANKING.md.
 */
import type { FeedWeights } from "./feedWeights";

/** Result-freshness decay (hours) for finished battles. */
export const FEED_RESULT_TAU_H = 10;
/** Don't repeat a participant within N neighbouring slots. */
export const FEED_DIVERSITY_WINDOW = 2;
/** "New creator" for cold-start exploration: account under 30 days, under 50 followers. */
export const NEW_CREATOR_MAX_AGE_MS = 30 * 86_400_000;
export const NEW_CREATOR_MAX_FOLLOWERS = 50;

export function isNewCreatorAt(createdAt: number, followersCount: number, now: number): boolean {
  return createdAt > 0 && now - createdAt < NEW_CREATOR_MAX_AGE_MS && followersCount < NEW_CREATOR_MAX_FOLLOWERS;
}

/** User-agnostic content score for one match (higher = show sooner). */
export function rankBaseScore(r: any, now: number, w: FeedWeights): number {
  const isCompleted = r.status === "completed";
  const startedAt = Number(r.activatedAt || r.createdAt || now);
  const finishedAt = Number(r.expiresAt || startedAt);
  const startAgeH = Math.max(0, (now - startedAt) / 3_600_000);
  const lifetimeH = Math.max(0.5, (finishedAt - startedAt) / 3_600_000);

  let reactions = 0;
  if (r.reactions && typeof r.reactions === "object") {
    for (const v of Object.values(r.reactions)) reactions += Number(v) || 0;
  }
  // Weighted engagement: shares > comments > likes/votes (harder actions count more).
  const engagement =
    (Number(r.totalVotes) || 0) +
    (Number(r.likeCount) || 0) +
    (Number(r.commentCount) || 0) * 2 +
    (Number(r.shareCount) || 0) * 3 +
    reactions;

  // Active: engagement rate since it started (a new hot battle out-ranks an old
  // slow one). Completed: average rate over its whole life (how hot it was).
  const velocity = engagement / ((isCompleted ? lifetimeH : startAgeH) + 2);

  // Active freshness decays from when it started. Completed "result freshness"
  // decays from when it FINISHED — a just-declared winner is fresh content, so
  // it surfaces near the top and only sinks as the result ages.
  const finishAgeH = Math.max(0, (now - finishedAt) / 3_600_000);
  const freshness = isCompleted ? Math.exp(-finishAgeH / FEED_RESULT_TAU_H) : Math.exp(-startAgeH / 24);

  // Closing-soon urgency only applies while voting is open.
  let urgency = 0;
  if (!isCompleted && Number.isFinite(finishedAt)) {
    const hoursLeft = (finishedAt - now) / 3_600_000;
    if (hoursLeft > 0 && hoursLeft <= 6) urgency = 1 - hoursLeft / 6;
  }
  const prize = Math.log1p(Number(r.entryFee) || 0);

  let score = w.freshness * freshness + w.velocity * Math.log1p(velocity) + w.urgency * urgency + w.prize * prize;
  // Prominence bump for a fresh result so winners surface instead of sinking to
  // the bottom; scaled by result-freshness so it fades as the result ages.
  if (isCompleted) score += w.result * freshness;
  return score;
}

/** What the per-viewer re-rank knows about the viewer. */
export interface ViewerSignals {
  follows: ReadonlySet<string>;
  /** Creators the viewer voted for before. */
  votedFor: ReadonlySet<string>;
  /** Battles the viewer already voted on. */
  votedMatches: ReadonlySet<string>;
  /** Creators whose profile the viewer visited. */
  visited: ReadonlySet<string>;
  /** Creators of battles the viewer marked "Not interested". */
  dismissedCreators: ReadonlySet<string>;
  /** Times each battle was shown to the viewer. */
  seen: Readonly<Record<string, number>>;
}

/** Base score plus the viewer's signals. `followed` drives the Following tab. */
export function personalScore(m: any, sig: ViewerSignals, w: FeedWeights): { s: number; followed: boolean } {
  const a = m.userA?.uid;
  const b = m.userB?.uid;
  let s = m._base as number;
  const followed = sig.follows.has(a) || sig.follows.has(b);
  if (followed) s += w.follow;
  if (sig.votedFor.has(a) || sig.votedFor.has(b)) s += w.votedAffinity;
  if (sig.visited.has(a) || sig.visited.has(b)) s += w.visitAffinity;
  // Negative feedback: the viewer said "Not interested" to a battle by this creator.
  if (sig.dismissedCreators.has(a) || sig.dismissedCreators.has(b)) s -= w.notInterested;
  if (m.status === "completed") {
    // Finished battle: you voted on it → you want to see who won, so boost
    // its result to you (the opposite of the active-feed novelty penalty).
    // No impression fatigue either — results only live for the short window.
    if (sig.votedMatches.has(m.id)) s += w.resultVotedBoost;
  } else {
    if (sig.votedMatches.has(m.id)) s -= w.votedPenalty;
    // Impression fatigue: shown before but not voted on → demote, scaled by
    // how many times it was shown (capped).
    const seenCount = sig.seen[m.id] || 0;
    if (seenCount > 0 && !sig.votedMatches.has(m.id)) {
      s -= w.seenPenalty * Math.min(seenCount, w.seenCap);
    }
  }
  return { s, followed };
}

/**
 * Diversity pass: no participant in several consecutive slots (Instagram-style).
 * Greedy: keep the score order, but skip a candidate whose participant appeared in
 * the last `window` picks and take the next distinct one instead.
 */
export function diversifyFeed(items: any[], window: number): any[] {
  if (items.length <= 2) return items;
  const pool = items.slice();
  const out: any[] = [];
  const recent: string[] = [];
  while (pool.length > 0) {
    let idx = pool.findIndex((m) => {
      const a = m.userA?.uid;
      const b = m.userB?.uid;
      return !(a && recent.includes(a)) && !(b && recent.includes(b));
    });
    if (idx === -1) idx = 0; // everything conflicts → take the best remaining
    const [chosen] = pool.splice(idx, 1);
    out.push(chosen);
    if (chosen.userA?.uid) recent.push(chosen.userA.uid);
    if (chosen.userB?.uid) recent.push(chosen.userB.uid);
    while (recent.length > window * 2) recent.shift();
  }
  return out;
}

/** Full per-viewer ordering of a scored pool (`_base` set), as the live feed does it. */
export function rankForViewer(candidates: any[], sig: ViewerSignals, w: FeedWeights, opts: { following?: boolean } = {}): any[] {
  let scored = candidates.map((m) => ({ m, ...personalScore(m, sig, w) }));
  if (opts.following) scored = scored.filter((x) => x.followed);
  return diversifyFeed(
    scored.sort((a, b) => b.s - a.s).map((x) => x.m),
    FEED_DIVERSITY_WINDOW,
  );
}
