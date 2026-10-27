/**
 * Where a piece of media goes: images to R2 as uploaded, video through Qencode.
 *
 * This module is the ONLY place that answers that question. Before it existed
 * the answer depended on who was asking — `POST /upload`, `createVideoUpload`
 * and the Expo client each had their own idea, so the same video could land in
 * different places depending on network luck.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SPLIT IS A SWITCH AND NOT A DELETION
 * ---------------------------------------------------------------------------
 * `integrations.video.provider` defaults to `"r2"` (the legacy path: a raw MP4
 * in the bucket). Removing that path before Qencode is provisioned would leave
 * no video path at all, and the only way back would be a redeploy.
 *
 * So the split is a setting. When Qencode is live, `POST /upload` REFUSES video
 * — every new video goes through `createVideoUpload` + `POST /upload/video` and
 * is encoded — and a stray client cannot put a raw MP4 back into a story. Until
 * then the legacy path keeps working and the deployment reports itself as
 * running it.
 *
 * Both directions are an admin-panel change (`Integrations -> Video`), with no
 * deploy and no client release: rollback has to be faster than a deploy.
 */
import type { Env } from "../types";
import { httpsError } from "./http";
import { qencodeConfig } from "./qencode";
import { getIntegrations } from "./integrations";
import type { MediaKind, MediaMime } from "./mediaTypes";
import { allowedMimesForCategory, categoryEverAcceptedVideo } from "./mediaCategories";

/**
 * The live routing decision.
 *
 * `r2AcceptsVideo` is the single flag every caller should branch on, rather than
 * re-deriving "is Qencode on" from credentials. The `reason` distinguishes the two
 * very different ways of ending up on the R2 path.
 */
export interface MediaRouting {
  /** Where new video goes. */
  videoProvider: "qencode" | "r2";
  /** Whether `POST /upload` still accepts raw video. False once Qencode is live. */
  r2AcceptsVideo: boolean;
  /**
   * - `qencode-live`    — Qencode is configured and selected. `POST /upload`
   *                       is closed to video.
   * - `provider-setting`— an operator has explicitly selected R2 for video.
   * - `not-configured`  — Qencode is SELECTED but its config is incomplete
   *                       (API key, or the R2 credentials it writes with), so
   *                       video is falling back to the legacy path. A
   *                       misconfiguration, not a choice: without naming it
   *                       separately the deployment looks identical to a
   *                       deliberate legacy setup. Surfaced by `/health/deep`.
   */
  reason: "qencode-live" | "provider-setting" | "not-configured";
}

/**
 * Resolve the routing decision.
 *
 * Reads config on every call; there is no caching here on purpose. The whole
 * point of driving this from a setting is that a cutover or a rollback takes
 * effect on the next request, and `getIntegrations` already has its own cache in
 * front of the settings store — so the image upload path pays one D1 read per
 * isolate per TTL, not one per request.
 *
 * FAILS OPEN, deliberately. `getIntegrations` swallows a settings read failure and
 * returns defaults, whose provider is `"r2"`, so during a D1 blip the legacy path
 * accepts video even when Qencode is live. That is the intended trade: the
 * alternative is that a transient settings failure blocks every video upload, and
 * a stray raw MP4 is both rare and recoverable — the backfill
 * (`/admin/videos/migrate-batch`) encodes legacy R2 videos. Worth knowing about
 * rather than discovering.
 */
export async function mediaRouting(env: Env): Promise<MediaRouting> {
  const [integrations, config] = await Promise.all([getIntegrations(env), qencodeConfig(env)]);

  if (integrations.video.provider !== "qencode") {
    return { videoProvider: "r2", r2AcceptsVideo: true, reason: "provider-setting" };
  }
  if (!config) {
    return { videoProvider: "r2", r2AcceptsVideo: true, reason: "not-configured" };
  }
  return { videoProvider: "qencode", r2AcceptsVideo: false, reason: "qencode-live" };
}

/**
 * The mime types an R2 prefix may receive right now.
 *
 * Combines the storage rule (what the prefix is for) with the routing rule (is
 * video still tolerated anywhere). Callers should use this rather than
 * `allowedMimesForCategory` directly, so the video decision cannot be forgotten
 * at a new upload site.
 */
export async function allowedMimesForUpload(env: Env, prefix: string): Promise<readonly MediaMime[]> {
  const routing = await mediaRouting(env);
  return allowedMimesForCategory(prefix, { allowLegacyVideo: routing.r2AcceptsVideo });
}

/**
 * Reject a raw video sent to `POST /upload` once Qencode owns video, with an
 * error that says what to do instead.
 *
 * The message names the action rather than the store. A client that reaches here
 * is an older build whose author cannot be told to read this comment, and
 * "upload failed" would send them looking at their connection; naming
 * `createVideoUpload` is what makes the report actionable when it arrives.
 */
export async function assertR2AcceptsKind(env: Env, kind: MediaKind, prefix: string): Promise<void> {
  if (kind !== "video") return;

  const routing = await mediaRouting(env);
  if (routing.r2AcceptsVideo) {
    // Legacy path still open — but the prefix must be one that historically took
    // video. An avatar was never allowed to be a video and still is not.
    if (!categoryEverAcceptedVideo(prefix)) {
      throw httpsError("invalid-argument", `${prefix} accepts images only.`);
    }
    return;
  }

  throw httpsError(
    "failed-precondition",
    "Videos are no longer uploaded to this endpoint. Use the createVideoUpload action and " +
      "POST /upload/video. Please update the app.",
  );
}
