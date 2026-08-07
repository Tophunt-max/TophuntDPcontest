/**
 * Thin client for the VoteCounter Durable Object (one instance per matchId).
 * Routes/cron call these instead of touching the vote counters in D1 directly.
 */
import type { Env } from "../types";

export interface VoteTally {
  alreadyVoted: boolean;
  votesA: number;
  votesB: number;
  total: number;
}

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
  const res = await stub(env, matchId).fetch("https://do.internal/vote", {
    method: "POST",
    body: JSON.stringify({ matchId, ...p }),
  });
  return res.json<VoteTally>();
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
  const res = await stub(env, matchId).fetch("https://do.internal/flush", {
    method: "POST",
    body: JSON.stringify({ matchId, uidA, uidB }),
  });
  return res.json<{ votesA: number; votesB: number; total: number }>();
}
