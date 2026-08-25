/**
 * Video encode reconciliation — the safety net under Bunny's webhook.
 *
 * A video's `ready`/`failed` transition normally arrives on the `/webhook/bunny`
 * callback. But a webhook is a single best-effort delivery: if it is lost (Bunny
 * outage, a deploy mid-flight, a transient 500 on our side) the `videos` row is
 * stranded in `processing` forever, and the client's "Processing…" overlay never
 * clears even though the video is actually playable. Separately, a TUS upload the
 * user abandoned leaves a row stuck in `uploading` and an object in Bunny that we
 * are billed for and nothing references.
 *
 * This module fixes both, and — crucially — makes the webhook and the cron apply
 * the SAME transition through one function (`applyBunnyEncodeResult`), so the two
 * paths can never drift into disagreeing about what "ready" means.
 */
import { and, eq, lt } from "drizzle-orm";
import type { Env } from "../types";
import { getDb, schema } from "../db";
import { now } from "./ids";
import {
  bunnyConfigured,
  bunnyMp4Url,
  bunnyPlaybackUrl,
  bunnyThumbnailUrl,
  deleteVideo,
  getVideo,
  mapBunnyStatus,
} from "./bunny";
import { promoteBackfilledVideo } from "./videoBackfill";
import { createNotification } from "./notify";

/**
 * A `processing` row older than this is treated as a missed webhook and polled
 * against Bunny directly. Encodes for a <=30s clip finish in well under a minute,
 * so 15 minutes is comfortably past "just slow".
 */
export const PROCESSING_STALE_MS = 15 * 60 * 1000;

/**
 * An `uploading` row older than this is an abandoned TUS upload. The upload
 * signature expires after an hour (see TUS_EXPIRY_SECONDS), so beyond two hours
 * the bytes are never arriving and the half-made Bunny object is pure cost.
 */
export const UPLOAD_ABANDON_MS = 2 * 60 * 60 * 1000;

/** Bound the Bunny API calls per tick so reconciliation can never run long. */
const BATCH = 25;

/**
 * Apply Bunny's current encode result for one video to its `videos` row.
 *
 * Shared by the webhook and the reconcile cron. Assumes the row exists and is not
 * already `ready` (both callers guarantee that). Re-fetches the authoritative
 * status from Bunny rather than trusting any caller-supplied value, and on
 * `ready` records the poster/duration, cuts a backfilled row over to Bunny, and
 * notifies the owner.
 *
 * @param scheduleNotify Lets the webhook fire the "video ready" notification in
 *   the background (`ctx.waitUntil`) so it can ack fast; the cron omits it and
 *   the notification is awaited best-effort instead.
 */
export async function applyBunnyEncodeResult(
  env: Env,
  guid: string,
  opts: { statusHint?: number; scheduleNotify?: (p: Promise<unknown>) => void } = {},
): Promise<"processing" | "ready" | "failed"> {
  const db = getDb(env);
  const ts = now();

  const meta = await getVideo(env, guid);
  const status = mapBunnyStatus(
    typeof meta?.status === "number" ? meta.status : opts.statusHint,
  );

  if (status === "processing") {
    await db.update(schema.videos).set({ status, updatedAt: ts }).where(eq(schema.videos.id, guid)).run();
    return "processing";
  }

  if (status === "failed") {
    await db
      .update(schema.videos)
      .set({ status, errorMessage: "Bunny reported encoding failure", updatedAt: ts })
      .where(eq(schema.videos.id, guid))
      .run();
    return "failed";
  }

  // ready
  const durationSec =
    typeof meta?.length === "number" && Number.isFinite(meta.length) ? Math.round(meta.length) : null;
  await db
    .update(schema.videos)
    .set({
      status: "ready",
      thumbnailUrl: await bunnyThumbnailUrl(env, guid),
      playbackUrl: await bunnyPlaybackUrl(env, guid),
      mp4Url: await bunnyMp4Url(env, guid),
      durationSec: durationSec ?? undefined,
      updatedAt: ts,
    })
    .where(eq(schema.videos.id, guid))
    .run();

  const owner = await db
    .select({
      ownerUid: schema.videos.ownerUid,
      targetType: schema.videos.targetType,
      targetId: schema.videos.targetId,
      targetSide: schema.videos.targetSide,
      r2SourceUrl: schema.videos.r2SourceUrl,
    })
    .from(schema.videos)
    .where(eq(schema.videos.id, guid))
    .get();

  // Backfilled rows cut their content over to Bunny only now that the playlist
  // exists (see promoteBackfilledVideo). A normal upload already stored the Bunny
  // URL, so this is a no-op for it.
  if (owner?.r2SourceUrl) {
    try {
      await promoteBackfilledVideo(env, { id: guid, ...owner });
    } catch (e) {
      console.error("[videoReconcile] promote failed", guid, e);
    }
  }

  if (owner?.ownerUid) {
    const p = createNotification(env, owner.ownerUid, {
      title: "Video ready 🎬",
      body:
        owner.targetType === "story"
          ? "Your story video has finished processing."
          : "Your contest video has finished processing.",
      type: "video_ready",
      targetId: guid,
    }).catch(() => {});
    if (opts.scheduleNotify) opts.scheduleNotify(p);
    else await p;
  }

  return "ready";
}

export interface ReconcileResult {
  skipped?: boolean;
  processingChecked: number;
  promotedReady: number;
  promotedFailed: number;
  abandoned: number;
}

/**
 * One reconciliation pass, driven by the 10-minute cron.
 *
 * Only meaningful when Bunny is the video provider; with R2 there is no encode
 * step and no `processing` state, so it no-ops.
 */
export async function reconcileVideos(env: Env): Promise<ReconcileResult> {
  if (!(await bunnyConfigured(env))) {
    return { skipped: true, processingChecked: 0, promotedReady: 0, promotedFailed: 0, abandoned: 0 };
  }

  const db = getDb(env);
  const nowTs = now();
  const result: ReconcileResult = { processingChecked: 0, promotedReady: 0, promotedFailed: 0, abandoned: 0 };

  // 1) Videos stuck in `processing` past the stale window — a webhook we never
  //    received. Poll Bunny and apply the real state.
  const stuck = await db
    .select({ id: schema.videos.id })
    .from(schema.videos)
    .where(and(eq(schema.videos.status, "processing"), lt(schema.videos.updatedAt, nowTs - PROCESSING_STALE_MS)))
    .limit(BATCH)
    .all();

  for (const v of stuck) {
    try {
      const outcome = await applyBunnyEncodeResult(env, v.id);
      result.processingChecked += 1;
      if (outcome === "ready") result.promotedReady += 1;
      else if (outcome === "failed") result.promotedFailed += 1;
    } catch (e) {
      console.error("[videoReconcile] processing reconcile failed", v.id, e);
    }
  }

  // 2) Uploads that never completed — free the Bunny object (cost) and close the
  //    row so it stops being polled and no client waits on it.
  const abandoned = await db
    .select({ id: schema.videos.id })
    .from(schema.videos)
    .where(and(eq(schema.videos.status, "uploading"), lt(schema.videos.createdAt, nowTs - UPLOAD_ABANDON_MS)))
    .limit(BATCH)
    .all();

  for (const v of abandoned) {
    try {
      await deleteVideo(env, v.id); // best-effort, 404-safe
      await db
        .update(schema.videos)
        .set({ status: "failed", errorMessage: "Abandoned upload (never completed)", updatedAt: now() })
        .where(and(eq(schema.videos.id, v.id), eq(schema.videos.status, "uploading")))
        .run();
      result.abandoned += 1;
    } catch (e) {
      console.error("[videoReconcile] abandoned cleanup failed", v.id, e);
    }
  }

  return result;
}
