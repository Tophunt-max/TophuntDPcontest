/**
 * Client-side video guardrails, checked the moment a video is picked.
 *
 * The server already caps uploads at 80 MB and only stores real video
 * containers, but that check lands AFTER the whole file has been sent — a brutal
 * outcome on Indian mobile data, where a user can spend minutes uploading a
 * 4-minute clip only to be rejected. And nothing limited a STORY video's length
 * at all, so a single entry could drive unbounded Bunny encode + storage cost.
 *
 * This validates the picker's own metadata (duration, file size) up front and
 * tells the user immediately, in plain language, before a byte is uploaded. It is
 * NOT a security control — the server remains the boundary — it is a fast, kind
 * failure. Values the picker does not provide (web often omits duration/size) are
 * treated as "can't tell here", and the server still enforces the hard limits.
 */

/** Story videos: long enough for a real moment, short enough to stay cheap. */
export const STORY_MAX_VIDEO_SEC = 60;
/** Contest entries are judged clips; kept tight. Matches the picker's recording cap. */
export const CONTEST_MAX_VIDEO_SEC = 30;
/** Mirrors the worker's MAX_VIDEO_BYTES so the client fails before the server does. */
export const MAX_VIDEO_BYTES = 80 * 1024 * 1024;

export interface PickedVideo {
  /** Duration in milliseconds, as expo-image-picker reports it. May be absent on web. */
  durationMs?: number | null;
  /** File size in bytes. May be absent on web / some Android providers. */
  fileSize?: number | null;
}

export interface VideoLimits {
  maxDurationSec: number;
  maxBytes?: number;
}

export type VideoValidation = { ok: true } | { ok: false; message: string };

function mb(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}

/**
 * Validate a picked video against a duration and size budget.
 *
 * Only rejects on values the picker actually gave us — an unknown duration or
 * size passes here and is caught server-side, so a platform that hides the
 * metadata never blocks a legitimate upload.
 */
export function validateVideo(asset: PickedVideo, limits: VideoLimits): VideoValidation {
  const maxBytes = limits.maxBytes ?? MAX_VIDEO_BYTES;

  if (typeof asset.durationMs === 'number' && Number.isFinite(asset.durationMs) && asset.durationMs > 0) {
    const seconds = asset.durationMs / 1000;
    // Half-second grace so a clip the user trimmed to exactly the limit is not
    // rejected by rounding.
    if (seconds > limits.maxDurationSec + 0.5) {
      return {
        ok: false,
        message: `That video is ${Math.round(seconds)}s. Please choose one up to ${limits.maxDurationSec}s.`,
      };
    }
  }

  if (typeof asset.fileSize === 'number' && Number.isFinite(asset.fileSize) && asset.fileSize > maxBytes) {
    return {
      ok: false,
      message: `That video is ${mb(asset.fileSize)} MB. Please choose one under ${mb(maxBytes)} MB.`,
    };
  }

  return { ok: true };
}
