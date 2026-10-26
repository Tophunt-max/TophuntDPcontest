/**
 * "Not interested" (negative feedback) for the For You / Following feeds.
 *
 * - The dismissed battle leaves that viewer's ranked feeds at once: it is
 *   filtered out of the candidate pool on every request, so the cached per-viewer
 *   order (which looks ids up in the filtered pool) drops it too.
 * - Other battles featuring the same creators are demoted by
 *   `FeedWeights.notInterested`. The dismissal version is part of the order-cache
 *   key, so a new dismissal re-ranks on the next request.
 * - Explore lists and search are shared, user-agnostic caches and are NOT
 *   filtered by this. Block or mute are the tools for "never show me this person".
 *
 * Fail-open: a lookup failure returns no dismissals and the feed still serves.
 */
import { and, desc, eq, lt } from "drizzle-orm";
import type { Env } from "../types";
import { getDb, schema } from "../db";

/** How many recent dismissals the feed considers. */
export const FEED_DISMISSAL_LOOKBACK = 200;
/** Rows older than this are pruned for the viewer on their next dismissal. */
export const FEED_DISMISSAL_RETENTION_MS = 90 * 86_400_000;

export interface FeedDismissals {
  matchIds: Set<string>;
  creators: Set<string>;
  /** Changes whenever the set changes; part of the order-cache key. */
  version: string;
}

export const NO_DISMISSALS: FeedDismissals = Object.freeze({
  matchIds: new Set<string>(),
  creators: new Set<string>(),
  version: "0",
}) as FeedDismissals;

export async function loadFeedDismissals(env: Env, uid: string): Promise<FeedDismissals> {
  try {
    const rows = await getDb(env)
      .select({
        matchId: schema.feedDismissals.matchId,
        creatorA: schema.feedDismissals.creatorA,
        creatorB: schema.feedDismissals.creatorB,
        createdAt: schema.feedDismissals.createdAt,
      })
      .from(schema.feedDismissals)
      .where(eq(schema.feedDismissals.viewerUid, uid))
      .orderBy(desc(schema.feedDismissals.createdAt))
      .limit(FEED_DISMISSAL_LOOKBACK)
      .all();
    if (!rows.length) return NO_DISMISSALS;
    const matchIds = new Set<string>();
    const creators = new Set<string>();
    for (const r of rows) {
      matchIds.add(r.matchId);
      if (r.creatorA) creators.add(r.creatorA);
      if (r.creatorB) creators.add(r.creatorB);
    }
    // Count + newest timestamp: a dismissal adds a row with a newer time, an undo
    // lowers the count. Either changes the version.
    return { matchIds, creators, version: `${rows.length}-${Number(rows[0].createdAt).toString(36)}` };
  } catch (e) {
    console.error("[feed] dismissal lookup failed", e);
    return NO_DISMISSALS;
  }
}

/** Record a dismissal (idempotent) and prune this viewer's expired rows. */
export async function recordFeedDismissal(
  env: Env,
  uid: string,
  match: { id: string; creatorA: string | null; creatorB: string | null },
  nowMs: number,
): Promise<void> {
  const db = getDb(env);
  await db.batch([
    db
      .insert(schema.feedDismissals)
      .values({ viewerUid: uid, matchId: match.id, creatorA: match.creatorA, creatorB: match.creatorB, createdAt: nowMs })
      .onConflictDoNothing(),
    db
      .delete(schema.feedDismissals)
      .where(and(eq(schema.feedDismissals.viewerUid, uid), lt(schema.feedDismissals.createdAt, nowMs - FEED_DISMISSAL_RETENTION_MS))),
  ]);
}

export async function removeFeedDismissal(env: Env, uid: string, matchId: string): Promise<void> {
  await getDb(env)
    .delete(schema.feedDismissals)
    .where(and(eq(schema.feedDismissals.viewerUid, uid), eq(schema.feedDismissals.matchId, matchId)));
}
