/**
 * Thin client for the VoteCounter Durable Object (one instance per matchId).
 * Uses native Durable Object RPC — plain method calls on the stub, no URLs.
 * Routes/cron call these instead of touching the vote counters in D1 directly.
 */
import type { Env } from "../types";
import type { VoteTally, ViewerVote } from "../voteCounter";

export type { VoteTally, ViewerVote } from "../voteCounter";

function stub(env: Env, matchId: string) {
  const id = env.VOTE_COUNTER.idFromName(matchId);
  return env.VOTE_COUNTER.get(id);
}

/** Cast a vote through the per-match DO. Dedup + tally happen inside the DO. */
export async function castVote(
  env: Env,
  matchId: string,
  p: {
    voterUid: string;
    votedForUid: string;
    deviceId?: string | null;
    uidA: string;
    uidB: string;
    expiresAt: number;
  },
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
 * Atomically close the match actor, flush every accepted vote to D1, and
 * return the authoritative final tally. Errors deliberately propagate so the
 * resolver retries later instead of settling from a stale D1 snapshot.
 */
export async function finalizeVotes(
  env: Env,
  matchId: string,
  uidA: string,
  uidB: string,
  expiresAt: number,
  force = false,
): Promise<{ votesA: number; votesB: number; total: number }> {
  return stub(env, matchId).closeAndFlush(matchId, uidA, uidB, expiresAt, force);
}

/** Return whether/how the authenticated viewer voted in this match. */
export async function getViewerVote(
  env: Env,
  matchId: string,
  voterUid: string,
): Promise<ViewerVote> {
  return stub(env, matchId).viewerVote(matchId, voterUid);
}

/**
 * Read-only authoritative tally from the per-match DO. Unlike finalizeVotes it
 * does NOT flush to D1 (no write), so it's safe to call on hot read paths (e.g.
 * the live match-detail view) to show up-to-the-second counts instead of D1's
 * last-flushed snapshot.
 */
export async function getLiveTally(
  env: Env,
  matchId: string,
  uidA: string,
  uidB: string,
): Promise<{ votesA: number; votesB: number; total: number }> {
  return stub(env, matchId).tally(matchId, uidA, uidB);
}
