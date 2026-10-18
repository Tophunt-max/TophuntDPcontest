/**
 * Contest battle stories — read-side privacy and lifecycle cleanup.
 *
 * What changed (migration 0055)
 * -----------------------------
 * A battle used to auto-post a solo `contest_announcement` story with the
 * creator's RAW entry the moment they created it (routes/api.ts `startMatch`),
 * long before an opponent existed. That was the reported defect. Nothing is
 * published at creation any more; publication is server-owned and happens only
 * after a real two-participant join, through lib/vsPublication.ts, which writes:
 *
 *   - ONE composite (`vs-cards/battles/<matchId>-v<N>.jpg`) owned by the MATCH, and
 *   - TWO `contest_vs` story rows (one per participant, deterministic ids) whose
 *     `media_url` is that shared composite.
 *
 * Two rows rather than one because `/read/stories/feed` groups strictly by
 * `stories.user_id`: each participant needs the story on their own ring.
 *
 * Why sharing one composite is safe now
 * -------------------------------------
 * The previous design refused to put the composite on the story rows for two
 * reasons; both are handled explicitly here instead:
 *
 *   blocking  — `applyVsStoryPrivacy` rewrites a VS story for any viewer who has
 *               hidden (blocked / muted / been blocked by) the OPPONENT: the row
 *               falls back to the owner's own entry, so the hidden person is never
 *               shown. The owner themselves is already filtered by the callers.
 *   ownership — the composite is never deleted through a story. `deleteStory`
 *               and account deletion skip contest-story media, and the object is
 *               removed only by `sweepVsComposites` once NO live story of the
 *               battle references it (or by account deletion of a participant,
 *               whose face it contains).
 */
import { and, eq, gt, inArray, isNotNull, lte, sql } from "drizzle-orm";
import type { Env } from "../types";
import { getDb, schema } from "../db";
import { deleteVsImageByPublicUrl, vsImageKeyFromPublicUrl } from "./r2";
import { STORY_TTL_MS } from "./vsPublication";

export { STORY_TTL_MS };

/**
 * Normalise a participant's media type to what the client understands.
 *
 * The contest flows write `"photo"` while the story viewer only checks for
 * `"image"`. Anything that is not explicitly a video is an image.
 */
export function storyMediaType(mediaType: unknown): "image" | "video" {
  return mediaType === "video" ? "video" : "image";
}

/** Story kinds whose media is contest media, never the author's personal upload. */
export const CONTEST_STORY_TYPES: readonly string[] = ["contest_vs", "contest_announcement", "contest_match_live"];

export function isContestStoryType(type: unknown): boolean {
  return typeof type === "string" && CONTEST_STORY_TYPES.includes(type);
}

/**
 * Per-viewer rewrite of VS stories whose opponent the viewer has hidden.
 *
 * Applied AFTER any shared cache (the composite is the same for everyone; the
 * hidden set is not). One indexed lookup, and only when there is something to
 * decide: a non-empty hidden set AND at least one VS row.
 *
 * A row that cannot fall back (the owner's own entry is gone) is dropped — never
 * shown with the hidden person in it.
 */
export async function applyVsStoryPrivacy<T extends Record<string, any>>(
  env: Env,
  rows: T[],
  hidden: Set<string>,
): Promise<T[]> {
  if (!hidden.size || !rows.length) return rows;
  const vsRows = rows.filter((r) => r?.type === "contest_vs" && r?.matchId);
  if (!vsRows.length) return rows;

  const matchIds = [...new Set(vsRows.map((r) => String(r.matchId)))].slice(0, 100);
  const matches = await getDb(env)
    .select({ id: schema.contestMatches.id, userA: schema.contestMatches.userA, userB: schema.contestMatches.userB })
    .from(schema.contestMatches)
    .where(inArray(schema.contestMatches.id, matchIds))
    .all();
  const byId = new Map(matches.map((m) => [m.id, m]));

  const out: T[] = [];
  for (const r of rows) {
    if (r?.type !== "contest_vs" || !r?.matchId) {
      out.push(r);
      continue;
    }
    const m = byId.get(String(r.matchId));
    const a = m?.userA as any;
    const b = m?.userB as any;
    const own = a?.uid === r.userId ? a : b?.uid === r.userId ? b : null;
    const opponent = own === a ? b : a;
    if (!m || !own) {
      // Cannot prove who is in the picture: fail closed.
      continue;
    }
    if (!opponent?.uid || !hidden.has(String(opponent.uid))) {
      out.push(r);
      continue;
    }
    if (!own.mediaUrl) continue;
    out.push({
      ...r,
      mediaUrl: own.mediaUrl,
      mediaType: storyMediaType(own.mediaType),
      // The client draws a head-to-head frame for `contest_vs`; as a solo entry
      // this row must render as a plain story instead.
      type: "contest_entry_solo",
      opponentHidden: true,
    });
  }
  return out;
}

/**
 * Reference-aware cleanup of the shared composite.
 *
 * The composite is owned by the MATCH and displayed by up to two stories. It is
 * deleted only when no live (unexpired) story of that battle remains — so one
 * participant deleting their story, or one row expiring, never blanks the other.
 *
 * Candidates are (a) battles whose VS stories just expired, and (b) published
 * battles older than the story window — the second catches the case where both
 * participants deleted their stories early, which would otherwise leave the
 * object referenced by nothing until the R2 lifecycle safety net.
 *
 * The match row and both original entries are untouched: match history stays.
 */
export async function sweepVsComposites(env: Env, nowMs: number): Promise<{ deleted: number }> {
  const db = getDb(env);
  const expired = await db
    .select({ matchId: schema.stories.matchId })
    .from(schema.stories)
    .where(and(lte(schema.stories.expiresAt, nowMs), eq(schema.stories.type, "contest_vs")))
    .limit(500)
    .all();
  const stale = await db
    .select({ id: schema.contestMatches.id })
    .from(schema.contestMatches)
    .where(
      and(
        eq(schema.contestMatches.vsStoryStatus, "published"),
        isNotNull(schema.contestMatches.vsImageUrl),
        lte(schema.contestMatches.vsStoryPublishedAt, nowMs - STORY_TTL_MS),
      ),
    )
    .limit(100)
    .all();
  const ids = [
    ...new Set([...expired.map((s) => s.matchId), ...stale.map((m) => m.id)].filter(Boolean) as string[]),
  ];

  let deleted = 0;
  for (const matchId of ids) {
    try {
      const live = await db
        .select({ id: schema.stories.id })
        .from(schema.stories)
        .where(and(eq(schema.stories.matchId, matchId), gt(schema.stories.expiresAt, nowMs)))
        .limit(1)
        .get();
      if (live) continue;
      const m = await db
        .select({ vsImageUrl: schema.contestMatches.vsImageUrl, vsStoryStatus: schema.contestMatches.vsStoryStatus })
        .from(schema.contestMatches)
        .where(eq(schema.contestMatches.id, matchId))
        .get();
      // Never pull the image out from under an in-flight publication.
      if (!m?.vsImageUrl || m.vsStoryStatus === "processing" || m.vsStoryStatus === "pending") continue;
      // Clear first, conditionally: a client reading a url that names a deleted
      // object renders an empty frame, while null falls back to the live layout.
      const cleared = await db
        .update(schema.contestMatches)
        .set({ vsImageUrl: null })
        .where(and(eq(schema.contestMatches.id, matchId), eq(schema.contestMatches.vsImageUrl, m.vsImageUrl)))
        .run();
      if (!Number(cleared.meta?.changes || 0)) continue;
      if (vsImageKeyFromPublicUrl(env, m.vsImageUrl)) {
        await deleteVsImageByPublicUrl(env, m.vsImageUrl);
        deleted++;
      }
    } catch (e) {
      // A card left behind costs storage; a throw here would stop the rest of the
      // schedule, including match settlement.
      console.error("[matchStories] composite cleanup failed (continuing)", matchId, e);
    }
  }
  return { deleted };
}

/**
 * Account deletion: a departing participant's face is in every composite of
 * theirs, so those objects are destroyed and every VS story that displays one
 * (including the OTHER participant's) is removed. Returns the urls to delete.
 */
export async function purgeVsCompositesForUser(env: Env, uid: string): Promise<string[]> {
  const rows = await env.DB.prepare(
    `SELECT id, vs_image_url FROM contest_matches
      WHERE vs_image_url IS NOT NULL
        AND (json_extract(user_a, '$.uid') = ? OR json_extract(user_b, '$.uid') = ?)`,
  )
    .bind(uid, uid)
    .all<{ id: string; vs_image_url: string }>();
  const urls: string[] = [];
  for (const r of rows.results || []) {
    await getDb(env).batch([
      getDb(env)
        .delete(schema.stories)
        .where(and(eq(schema.stories.matchId, r.id), sql`${schema.stories.type} IN ('contest_vs', 'contest_match_live')`)),
      getDb(env).update(schema.contestMatches).set({ vsImageUrl: null }).where(eq(schema.contestMatches.id, r.id)),
    ]);
    if (vsImageKeyFromPublicUrl(env, r.vs_image_url)) urls.push(r.vs_image_url);
  }
  return urls;
}
