/**
 * Thin client for the VoteCounter Durable Object (one instance per matchId).
 * Uses native Durable Object RPC — plain method calls on the stub, no URLs.
 * Routes/cron call these instead of touching the vote counters in D1 directly.
 */
import type { Env } from "../types";
import type { VoteTally } from "../voteCounter";

export type { VoteTally } from "../voteCounter";

function stub(env: Env, matchId: string) {
  const id = env.VOTE_COUNTER.idFromName(matchId);
  return env.VOTE_COUNTER.get(id);
}

/** Cast a vote through the per-match DO. Dedup + tally happen inside the DO. */
export async function castVote(
  env: Env,
  matchId: string,
  p: { voterUid: string; votedForUid: string; deviceId?: string | null; uidA: string; uidB: string },
): Promise<VoteTally> {
  return stub(env, matchId).vote({ matchId, ...p });
}

/**
 * Bump a match engagement counter (like / comment / share / reaction) inside
 * the per-match DO instead of updating the hot contest_matches row directly.
 * `name` is "like" | "comment" | "share" | "react:<type>". `delta` may be -1
 * (e.g. unlike); the DO clamps counters at 0. Returns the current counters.
 */
export async function bumpEngagement(
  env: Env,
  matchId: string,
  name: string,
  delta: number,
): Promise<Record<string, number>> {
  return stub(env, matchId).engagement(matchId, name, delta);
}

/**
 * Flush the DO's accumulated votes to D1 and return the authoritative tally.
 * Called by the cron resolver before it decides a winner. Best-effort: on
 * failure the caller falls back to the last-flushed values already in D1.
 */
export async function finalizeVotes(
  env: Env,
  matchId: string,
  uidA: string,
  uidB: string,
): Promise<{ votesA: number; votesB: number; total: number }> {
  return stub(env, matchId).flushTally(matchId, uidA, uidB);
}
