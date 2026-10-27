/**
 * Backfill: encode existing legacy R2 videos (raw MP4s) to HLS with Qencode.
 *
 * Two properties make this safe to run against production traffic:
 *
 * 1. **No download/re-upload.** Qencode pulls the R2 original itself through a
 *    presigned URL, and writes the HLS back into the same bucket.
 * 2. **`mediaUrl` is NOT rewritten here.** The new playlist does not exist until
 *    the encode finishes, so flipping the URL at enqueue time would break
 *    playback for every migrated row. Instead the row keeps pointing at the
 *    original and `applyEncodeResult` performs the swap once the video is
 *    genuinely `ready` (see `promoteBackfilledVideo`). The R2 original is left in
 *    place — delete it only after a confidence window of confirmed playback.
 *
 * Resumability comes from the `video_provider IS NULL` filter: enqueued rows are
 * marked `migrating`, so re-running never re-enqueues the same row.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Env } from "../types";
import { getDb, schema } from "../db";
import { playbackUrlFor, qencodeConfigured, startEncode } from "./qencode";
import { newId, now } from "./ids";
import { mediaKeyFromPublicUrl } from "./r2";

export interface BackfillResult {
  scanned: number;
  enqueued: number;
  failed: number;
  done: boolean;
  errors: string[];
}

/**
 * Is this media URL still an R2 original rather than an encoded playlist?
 *
 * Defined by OWNERSHIP, not by key shape. It used to be
 * `url.includes("/videos/")`, matching the old `{folder}/videos/{uuid}` layout —
 * and the current layout has no such segment, so that test silently stopped
 * matching anything written after the change. The backfill would have reported
 * `scanned: 0` and looked complete while every recently uploaded video stayed
 * un-migratable, which matters most precisely because the legacy R2 path is the
 * only video path running until Qencode is provisioned.
 *
 * The two conditions:
 *  - the URL maps to a key in OUR bucket (`mediaKeyFromPublicUrl` covers the
 *    current base and every legacy base, and both key layouts), and
 *  - it is not HLS. Load-bearing now that encoded output lives in the SAME
 *    bucket (`videos/<id>/playlist.m3u8` is "in our bucket" too): without it the
 *    backfill would try to re-encode its own output.
 *
 * Callers pair this with a `media_type = 'video'` / `type = 'video'` filter, so
 * "not HLS and in our bucket" is sufficient to mean "R2 video original".
 */
function isR2Video(env: Env, url: unknown): url is string {
  if (typeof url !== "string" || !url) return false;
  if (/\.m3u8(\?|$)/i.test(url)) return false;
  return mediaKeyFromPublicUrl(env, url) !== null;
}

/**
 * Enqueue one batch of stories whose media is still an R2 video.
 */
async function backfillStories(env: Env, limit: number, result: BackfillResult, callbackOrigin: string | null): Promise<void> {
  const db = getDb(env);

  const rows = await db
    .select({ id: schema.stories.id, userId: schema.stories.userId, mediaUrl: schema.stories.mediaUrl })
    .from(schema.stories)
    .where(
      and(
        isNull(schema.stories.videoProvider),
        eq(schema.stories.mediaType, "video"),
        // No key-shape prefilter. `videoProvider IS NULL` plus `mediaType =
        // 'video'` already scopes this to un-migrated video stories; the old
        // `LIKE '%/videos/%'` narrowed it to one key layout and silently excluded
        // everything written under the current one.
      ),
    )
    .limit(limit)
    .all();

  result.scanned += rows.length;

  for (const row of rows) {
    if (!isR2Video(env, row.mediaUrl)) continue;
    try {
      const id = newId();
      const jobId = await startEncode(env, {
        videoId: id,
        sourceKey: mediaKeyFromPublicUrl(env, row.mediaUrl)!,
        callbackOrigin,
      });

      const ts = now();
      await db.insert(schema.videos).values({
        id,
        ownerUid: row.userId,
        provider: "qencode",
        status: "processing",
        jobId,
        targetType: "story",
        targetId: row.id,
        r2SourceUrl: row.mediaUrl,
        createdAt: ts,
        updatedAt: ts,
      });

      // 'migrating' keeps this row out of the next batch without yet claiming the
      // encoded version is being served.
      await db
        .update(schema.stories)
        .set({ videoProvider: "migrating" })
        .where(and(eq(schema.stories.id, row.id), isNull(schema.stories.videoProvider)))
        .run();

      result.enqueued += 1;
    } catch (e: any) {
      result.failed += 1;
      result.errors.push(`story ${row.id}: ${e?.message || e}`);
    }
  }
}

/**
 * Enqueue one batch of contest matches. Each match can carry TWO participant
 * videos (user_a / user_b JSON), so both sides are enqueued before the match is
 * marked, and `target_side` records which is which.
 */
async function backfillMatches(env: Env, limit: number, result: BackfillResult, callbackOrigin: string | null): Promise<void> {
  const db = getDb(env);

  const rows = await db
    .select({
      id: schema.contestMatches.id,
      userA: schema.contestMatches.userA,
      userB: schema.contestMatches.userB,
    })
    .from(schema.contestMatches)
    .where(and(isNull(schema.contestMatches.videoProvider), eq(schema.contestMatches.type, "video")))
    .limit(limit)
    .all();

  result.scanned += rows.length;

  for (const row of rows) {
    const sides: { side: "A" | "B"; participant: any }[] = [
      { side: "A", participant: row.userA },
      { side: "B", participant: row.userB },
    ];

    let sideFailed = false;
    let enqueuedAny = false;

    for (const { side, participant } of sides) {
      const mediaUrl = participant?.mediaUrl;
      if (!isR2Video(env, mediaUrl)) continue;
      try {
        const id = newId();
        const jobId = await startEncode(env, {
          videoId: id,
          sourceKey: mediaKeyFromPublicUrl(env, mediaUrl)!,
          callbackOrigin,
        });

        const ts = now();
        await db.insert(schema.videos).values({
          id,
          ownerUid: participant?.uid || "unknown",
          provider: "qencode",
          status: "processing",
          jobId,
          targetType: "contest_entry",
          targetId: row.id,
          targetSide: side,
          r2SourceUrl: mediaUrl,
          createdAt: ts,
          updatedAt: ts,
        });
        enqueuedAny = true;
      } catch (e: any) {
        sideFailed = true;
        result.errors.push(`match ${row.id} side ${side}: ${e?.message || e}`);
      }
    }

    // Only mark the match once BOTH sides are safely enqueued — otherwise the
    // failed side would never be retried.
    if (enqueuedAny && !sideFailed) {
      await db
        .update(schema.contestMatches)
        .set({ videoProvider: "migrating" })
        .where(and(eq(schema.contestMatches.id, row.id), isNull(schema.contestMatches.videoProvider)))
        .run();
      result.enqueued += 1;
    } else if (sideFailed) {
      result.failed += 1;
    }
  }
}

/**
 * Run one resumable batch. Safe to call repeatedly; `done` is true when there is
 * nothing left to enqueue.
 */
export async function runVideoBackfillBatch(
  env: Env,
  opts: { limit?: number; target?: "stories" | "matches" | "all"; callbackOrigin?: string | null } = {},
): Promise<BackfillResult> {
  if (!(await qencodeConfigured(env))) {
    throw new Error(
      "Qencode is not live: select it in Integrations -> Video and set QENCODE_API_KEY plus the R2 credentials " +
        "(R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY).",
    );
  }
  const callbackOrigin = opts.callbackOrigin ?? null;
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
  const target = opts.target ?? "all";
  const result: BackfillResult = { scanned: 0, enqueued: 0, failed: 0, done: false, errors: [] };

  if (target === "stories" || target === "all") await backfillStories(env, limit, result, callbackOrigin);
  if (target === "matches" || target === "all") await backfillMatches(env, limit, result, callbackOrigin);

  result.done = result.scanned === 0;
  return result;
}

/**
 * Called from `applyEncodeResult` when a BACKFILLED video reaches `ready`.
 *
 * This is the actual cutover: only now is it safe to point the content row at
 * the encoded playlist, because it finally exists. Until this runs the row keeps
 * serving the original R2 file, which is what allows old and new videos to
 * coexist with no big-bang switch.
 */
export async function promoteBackfilledVideo(
  env: Env,
  video: {
    id: string;
    targetType: string | null;
    targetId: string | null;
    targetSide: string | null;
    r2SourceUrl: string | null;
  },
): Promise<void> {
  // Not a backfilled video (a normal upload already stored the playlist URL).
  if (!video.r2SourceUrl || !video.targetId) return;

  const db = getDb(env);
  const url = playbackUrlFor(env, video.id);

  if (video.targetType === "story") {
    await db
      .update(schema.stories)
      .set({ mediaUrl: url, videoProvider: "qencode" })
      .where(eq(schema.stories.id, video.targetId))
      .run();
    return;
  }

  if (video.targetType === "contest_entry" && (video.targetSide === "A" || video.targetSide === "B")) {
    const column = video.targetSide === "A" ? schema.contestMatches.userA : schema.contestMatches.userB;
    const row = await db
      .select({ userA: schema.contestMatches.userA, userB: schema.contestMatches.userB })
      .from(schema.contestMatches)
      .where(eq(schema.contestMatches.id, video.targetId))
      .get();
    if (!row) return;

    const participant: any = video.targetSide === "A" ? row.userA : row.userB;
    if (!participant) return;
    const updated = { ...participant, mediaUrl: url };

    await db
      .update(schema.contestMatches)
      .set({ [video.targetSide === "A" ? "userA" : "userB"]: updated } as any)
      .where(eq(schema.contestMatches.id, video.targetId))
      .run();

    // Flip the match marker only when NEITHER side still points at R2.
    const after = await db
      .select({ userA: schema.contestMatches.userA, userB: schema.contestMatches.userB })
      .from(schema.contestMatches)
      .where(eq(schema.contestMatches.id, video.targetId))
      .get();
    const stillOnR2 = [after?.userA, after?.userB].some((p: any) => isR2Video(env, p?.mediaUrl));
    if (!stillOnR2) {
      await db
        .update(schema.contestMatches)
        .set({ videoProvider: "qencode" })
        .where(eq(schema.contestMatches.id, video.targetId))
        .run();
    }
  }
}
