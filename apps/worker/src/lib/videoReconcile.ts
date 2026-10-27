/**
 * Video encode reconciliation — one transition, three callers.
 *
 * A video's `ready`/`failed` transition normally arrives on `/webhook/qencode`.
 * But a callback is a single best-effort delivery: if it is lost (Qencode
 * outage, a deploy mid-flight, a transient 500 here) the `videos` row is
 * stranded in `processing` and the app's "Processing…" overlay never clears even
 * though the video plays. Separately, an upload that never finished leaves a row
 * in `uploading`, and possibly a raw source in R2 nothing will ever encode.
 *
 * This module fixes both, and makes the webhook, the cron and the `videoStatus`
 * live recheck apply the SAME transition through `applyEncodeResult`, so they
 * can never disagree about what "ready" means.
 *
 * "Ready" requires two independent facts: Qencode says the job completed, AND
 * the playlist is actually in R2. The second check is what makes a wrong
 * destination, a revoked R2 token, or a misread status shape fail loudly as
 * `failed` instead of publishing a story whose video 404s forever.
 */
import { and, eq, gt, isNotNull, isNull, lt } from "drizzle-orm";
import type { Env } from "../types";
import { getDb, schema } from "../db";
import { now } from "./ids";
import {
  deleteVideoObjects,
  getJobStatus,
  mapQencodeStatus,
  playbackUrlFor,
  playlistKey,
  qencodeConfigured,
  startEncode,
  thumbnailKey,
  thumbnailUrlFor,
} from "./qencode";
import { promoteBackfilledVideo } from "./videoBackfill";
import { createNotification } from "./notify";

/**
 * A `processing` row not updated for this long is treated as a missed callback
 * and polled. Encodes of a <=60s clip finish in a minute or two.
 */
export const PROCESSING_STALE_MS = 15 * 60 * 1000;

/**
 * A `processing` row older than this is given up on: the job is lost or stuck,
 * and leaving it would keep the app showing "Processing…" forever.
 */
export const PROCESSING_GIVE_UP_MS = 6 * 60 * 60 * 1000;

/**
 * An `uploading` row older than this is abandoned: the app never finished
 * sending the file, or the encode could never be started.
 */
export const UPLOAD_ABANDON_MS = 2 * 60 * 60 * 1000;

/**
 * An uploaded source whose encode failed to START is retried by the cron after
 * this long (the upload request itself already tried once).
 */
export const START_RETRY_AFTER_MS = 60 * 1000;

/**
 * How stale an unfinished row may be before `videoStatus` re-checks it.
 *
 * The cron waits 15 minutes before spending a Qencode call and only runs every
 * 10 — right for a background sweep, wrong for someone watching a "Processing…"
 * overlay. Each check bumps `updatedAt`, so a client polling every 5s produces at
 * most one Qencode call per video per window, however many viewers there are.
 */
export const LIVE_STATUS_RECHECK_MS = 15 * 1000;

/** Bound the Qencode calls per cron tick. */
const BATCH = 25;

export type EncodeOutcome = "uploading" | "processing" | "ready" | "failed";

/**
 * Apply Qencode's current result for one video to its `videos` row.
 *
 * Reads the job handle from the row and the state from Qencode — never from the
 * caller, so an unauthenticated or replayed callback can only cause a re-check.
 * On `ready` it records the URLs and duration, deletes the raw source, cuts a
 * backfilled row over, and notifies the owner. On `failed` it deletes whatever
 * was stored, so a failed encode does not keep costing storage.
 *
 * @param scheduleNotify Lets the webhook fire the "video ready" notification in
 *   the background (`ctx.waitUntil`) so it acks fast; the cron awaits it instead.
 */
export async function applyEncodeResult(
  env: Env,
  id: string,
  opts: { scheduleNotify?: (p: Promise<unknown>) => void } = {},
): Promise<EncodeOutcome> {
  const db = getDb(env);
  const row = await db.select().from(schema.videos).where(eq(schema.videos.id, id)).get();
  if (!row) return "failed";
  if (row.status === "ready" || row.status === "failed") return row.status;
  // No job yet: the bytes have not arrived, or the encode has not been started.
  // Nothing to ask Qencode; the cron's start-retry and abandon passes own this.
  if (!row.jobId) return row.status === "processing" ? "processing" : "uploading";

  const ts = now();
  const job = await getJobStatus(row.jobId);
  let status = mapQencodeStatus(job);

  let errorMessage: string | null = null;
  if (status === "failed") {
    errorMessage = job?.errorDescription || "Qencode reported an encoding failure";
  }
  if (status === "ready" && !(await env.MEDIA.head(playlistKey(id)))) {
    // Qencode says done, but nothing playable landed where we told it to write.
    status = "failed";
    errorMessage = "Encode completed but no playlist was written to R2 (check the R2 credentials Qencode uses)";
  }

  if (status === "processing") {
    await db
      .update(schema.videos)
      .set({ status: "processing", updatedAt: ts })
      .where(and(eq(schema.videos.id, id), eq(schema.videos.status, row.status)))
      .run();
    return "processing";
  }

  if (status === "failed") {
    const claim = await db
      .update(schema.videos)
      .set({ status: "failed", errorMessage, updatedAt: ts })
      .where(and(eq(schema.videos.id, id), eq(schema.videos.status, row.status)))
      .run();
    if (claim.meta.changes > 0) {
      // A backfilled row's source is the live R2 original its story still plays;
      // only the temporary upload (`sourceKey`) is ours to delete.
      await deleteVideoObjects(env, id, row.sourceKey).catch((e) =>
        console.error("[videoReconcile] cleanup after failed encode failed", id, e),
      );
    }
    return "failed";
  }

  // ready — claimed with a status CAS so a concurrent webhook and cron cannot
  // both notify the owner.
  const claim = await db
    .update(schema.videos)
    .set({
      status: "ready",
      playbackUrl: playbackUrlFor(env, id),
      thumbnailUrl: (await env.MEDIA.head(thumbnailKey(id))) ? thumbnailUrlFor(env, id) : null,
      // No progressive MP4 is produced: web plays the HLS through hls.js.
      mp4Url: null,
      durationSec: job?.durationSec ?? undefined,
      sourceKey: null,
      errorMessage: null,
      updatedAt: ts,
    })
    .where(and(eq(schema.videos.id, id), eq(schema.videos.status, row.status)))
    .run();
  if (claim.meta.changes === 0) return "ready";

  if (row.sourceKey) {
    await env.MEDIA.delete(row.sourceKey).catch((e) =>
      console.error("[videoReconcile] source delete failed (2-day lifecycle rule is the net)", id, e),
    );
  }

  // Backfilled rows cut their content over only now that the playlist exists
  // (see promoteBackfilledVideo). A normal upload already stored the URL.
  if (row.r2SourceUrl) {
    try {
      await promoteBackfilledVideo(env, { ...row, id });
    } catch (e) {
      console.error("[videoReconcile] promote failed", id, e);
    }
  }

  if (row.ownerUid) {
    const p = createNotification(env, row.ownerUid, {
      title: "Video ready 🎬",
      body:
        row.targetType === "story"
          ? "Your story video has finished processing."
          : "Your contest video has finished processing.",
      type: "video_ready",
      targetId: id,
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
  encodesStarted: number;
  abandoned: number;
}

/**
 * One reconciliation pass, driven by the 10-minute cron.
 *
 * Only meaningful when Qencode is the video provider; the legacy R2 path has no
 * encode step and no `processing` state.
 */
export async function reconcileVideos(env: Env): Promise<ReconcileResult> {
  const result: ReconcileResult = {
    processingChecked: 0,
    promotedReady: 0,
    promotedFailed: 0,
    encodesStarted: 0,
    abandoned: 0,
  };
  if (!(await qencodeConfigured(env))) return { skipped: true, ...result };

  const db = getDb(env);
  const nowTs = now();

  const count = (outcome: EncodeOutcome) => {
    result.processingChecked += 1;
    if (outcome === "ready") result.promotedReady += 1;
    else if (outcome === "failed") result.promotedFailed += 1;
  };

  // 1) `processing` past the stale window — a callback we never received.
  const stuck = await db
    .select({ id: schema.videos.id, createdAt: schema.videos.createdAt, sourceKey: schema.videos.sourceKey })
    .from(schema.videos)
    .where(and(eq(schema.videos.status, "processing"), lt(schema.videos.updatedAt, nowTs - PROCESSING_STALE_MS)))
    .limit(BATCH)
    .all();
  for (const v of stuck) {
    try {
      const outcome = await applyEncodeResult(env, v.id);
      if (outcome === "processing" && Number(v.createdAt) < nowTs - PROCESSING_GIVE_UP_MS) {
        // Hours past any real encode. Stop the overlay and stop paying for storage.
        const gaveUp = await db
          .update(schema.videos)
          .set({ status: "failed", errorMessage: "Encode never completed", updatedAt: now() })
          .where(and(eq(schema.videos.id, v.id), eq(schema.videos.status, "processing")))
          .run();
        if (gaveUp.meta.changes > 0) await deleteVideoObjects(env, v.id, v.sourceKey);
        count("failed");
        continue;
      }
      count(outcome);
    } catch (e) {
      console.error("[videoReconcile] processing reconcile failed", v.id, e);
    }
  }

  // 2) Source uploaded, encode never started (Qencode was unreachable during the
  //    upload request). Start it now. No callback origin: there is no request,
  //    so this job resolves through pass 1 and the `videoStatus` recheck.
  const unstarted = await db
    .select({ id: schema.videos.id, sourceKey: schema.videos.sourceKey })
    .from(schema.videos)
    .where(
      and(
        eq(schema.videos.status, "uploading"),
        isNotNull(schema.videos.sourceKey),
        isNull(schema.videos.jobId),
        lt(schema.videos.updatedAt, nowTs - START_RETRY_AFTER_MS),
        // Past the abandon window, pass 3 owns it.
        gt(schema.videos.createdAt, nowTs - UPLOAD_ABANDON_MS),
      ),
    )
    .limit(BATCH)
    .all();
  for (const v of unstarted) {
    if (!v.sourceKey) continue;
    try {
      const jobId = await startEncode(env, { videoId: v.id, sourceKey: v.sourceKey, callbackOrigin: null });
      await db
        .update(schema.videos)
        .set({ jobId, status: "processing", updatedAt: now() })
        .where(and(eq(schema.videos.id, v.id), eq(schema.videos.status, "uploading"), isNull(schema.videos.jobId)))
        .run();
      result.encodesStarted += 1;
    } catch (e) {
      // Bump updatedAt so a dead Qencode costs one attempt per row per minute,
      // not one per row per tick forever; pass 3 ends it at the abandon window.
      await db.update(schema.videos).set({ updatedAt: now() }).where(eq(schema.videos.id, v.id)).run();
      console.error("[videoReconcile] encode start retry failed", v.id, e);
    }
  }

  // 3) Uploads that never became a job within the abandon window. With Qencode,
  //    `uploading` is set by the SERVER (bytes stored + job started flips it to
  //    `processing` in the same request), so this state really does mean the
  //    encode never began — unlike Bunny, where it only meant "the app never
  //    told us", and deleting on that evidence destroyed real videos.
  const abandoned = await db
    .select({ id: schema.videos.id, sourceKey: schema.videos.sourceKey })
    .from(schema.videos)
    .where(and(eq(schema.videos.status, "uploading"), lt(schema.videos.createdAt, nowTs - UPLOAD_ABANDON_MS)))
    .limit(BATCH)
    .all();
  for (const v of abandoned) {
    try {
      const closed = await db
        .update(schema.videos)
        .set({ status: "failed", errorMessage: "Abandoned upload (encode never started)", updatedAt: now() })
        .where(and(eq(schema.videos.id, v.id), eq(schema.videos.status, "uploading")))
        .run();
      if (closed.meta.changes > 0) await deleteVideoObjects(env, v.id, v.sourceKey);
      result.abandoned += 1;
    } catch (e) {
      console.error("[videoReconcile] abandoned cleanup failed", v.id, e);
    }
  }

  return result;
}
