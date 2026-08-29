/**
 * Where a piece of media goes: images to R2, video to Bunny Stream.
 *
 * This module is the ONLY place that answers that question. It existed nowhere
 * before, which is why the answer was different depending on who was asking:
 * `POST /upload` accepted `video/mp4` into five R2 prefixes, `createVideoUpload`
 * preferred Bunny, and the Expo client silently fell back from one to the other
 * on any error — so the same video could land in either store depending on
 * network luck, and nothing in the system could state which store was
 * authoritative.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SPLIT IS A SWITCH AND NOT A DELETION
 * ---------------------------------------------------------------------------
 * Deleting the R2 video path outright would have been a one-line change and an
 * outage. Bunny is not provisioned in this deployment yet
 * (`integrations.video.provider` defaults to `"r2"`, `BUNNY_CDN_HOSTNAME` is
 * `""`), so with R2 closed to video and Bunny unreachable there would be no
 * video path at all: every story and every video battle would fail to upload,
 * and the only way back would be a redeploy.
 *
 * So the split is enforced by the provider setting that already existed. When
 * Bunny is live, R2 REFUSES video — the separation is real and a stray client
 * cannot put a video back in the bucket. Until then R2 keeps accepting it and
 * the deployment reports itself as running the legacy path.
 *
 * Both directions are a settings change in the admin panel, with no deploy and
 * no client release: `Integrations -> Video`. That is deliberate — the rollback
 * from a broken Bunny library has to be faster than a deploy.
 */
import type { Env } from "../types";
import { httpsError } from "./http";
import { bunnyConfig } from "./bunny";
import { getIntegrations } from "./integrations";
import type { MediaKind, MediaMime } from "./mediaTypes";
import { allowedMimesForCategory, categoryEverAcceptedVideo } from "./mediaCategories";

/**
 * The live routing decision.
 *
 * `r2AcceptsVideo` is the single flag every caller should branch on, rather than
 * re-deriving "is Bunny on" from credentials. The `reason` distinguishes the two
 * very different ways of ending up on the R2 path.
 */
export interface MediaRouting {
  /** Where new video is stored. */
  videoProvider: "bunny" | "r2";
  /** Whether R2 will still accept video bytes. False once Bunny is live. */
  r2AcceptsVideo: boolean;
  /**
   * - `bunny-live`      — Bunny is configured and selected. R2 is closed to video.
   * - `provider-setting`— an operator has explicitly selected R2 for video.
   * - `not-configured`  — Bunny is SELECTED but its config is incomplete, so
   *                       video is falling back to R2. This is a
   *                       misconfiguration, not a choice: someone switched the
   *                       provider and did not finish, and without naming it
   *                       separately the deployment looks identical to a
   *                       deliberate legacy setup. Surfaced by `/health/deep`.
   */
  reason: "bunny-live" | "provider-setting" | "not-configured";
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
 * returns defaults, whose provider is `"r2"`, so during a D1 blip R2 keeps
 * accepting video even when Bunny is live. That is the intended trade: the
 * alternative is that a transient settings failure blocks every video upload, and
 * a stray video in the image bucket is both rare and recoverable — the Phase 3
 * backfill script moves R2 videos into Bunny. Worth knowing about rather than
 * discovering.
 */
export async function mediaRouting(env: Env): Promise<MediaRouting> {
  const [integrations, config] = await Promise.all([getIntegrations(env), bunnyConfig(env)]);

  if (integrations.video.provider !== "bunny") {
    return { videoProvider: "r2", r2AcceptsVideo: true, reason: "provider-setting" };
  }
  if (!config) {
    return { videoProvider: "r2", r2AcceptsVideo: true, reason: "not-configured" };
  }
  return { videoProvider: "bunny", r2AcceptsVideo: false, reason: "bunny-live" };
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
 * Reject a video bound for R2 once Bunny owns video, with an error that says
 * what to do instead.
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
    "Videos are no longer uploaded to this endpoint. Use the createVideoUpload action, which uploads " +
      "directly to Bunny Stream. Please update the app.",
  );
}
