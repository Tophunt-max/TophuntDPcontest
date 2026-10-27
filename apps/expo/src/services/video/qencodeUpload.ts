import { callApi } from '../api';
import { UploadCancelledError, uploadVideoSource } from '@/src/lib/uploadToR2';

/**
 * Video upload for the Qencode pipeline.
 *
 * Flow:
 *   createVideoUpload (Worker, `upload: "worker"`) -> { videoId, uploadPath, playbackUrl }
 *     -> POST {uploadPath} with the file (Worker verifies it, stores it in R2 and
 *        starts the Qencode encode)
 *     -> the HLS playlist URL is stored as the media URL; `useVideoStatus` shows
 *        "Processing…" until the encode is ready.
 *
 * The app never talks to Qencode: its upload credential can also start jobs,
 * so the Worker keeps it. See apps/worker/src/lib/qencode.ts.
 *
 * Callers should not use this directly — `services/media/uploadVideo.ts` wraps
 * it with the fallback decision, so that decision lives in one place.
 */

export interface VideoUploadResult {
  provider: 'qencode';
  videoId: string;
  /** HLS playlist — store this as the media URL. */
  playbackUrl: string;
  thumbnailUrl: string | null;
}

/**
 * Why a discriminated result and not `VideoUploadResult | null`.
 *
 * `null` used to mean "not configured", and every caller read it as "use R2".
 * That is right while the legacy R2 path accepts video and wrong once it does
 * not. `r2Fallback` is the server's own answer to "is that path still open".
 *
 * A THROWN error means the video service is live and the upload itself failed.
 * The legacy path is closed in that state by definition, so the error belongs in
 * front of the user. `services/media/uploadVideo.ts` holds that reasoning.
 */
export type VideoUploadOutcome =
  | ({ status: 'uploaded' } & VideoUploadResult)
  | { status: 'not-configured'; r2Fallback: boolean }
  /**
   * Could not even ask the server where this video belongs — `createVideoUpload`
   * itself failed (5xx, dropped connection, token refresh). Nothing was created,
   * so this says NOTHING about whether the encoder is live, and the caller is
   * free to try R2.
   */
  | { status: 'unavailable'; error: unknown };

interface CreateUploadResponse {
  configured: boolean;
  /** Whether `POST /upload` still accepts video. Absent on older Workers. */
  r2Fallback?: boolean;
  provider?: string;
  videoId?: string;
  uploadPath?: string;
  playbackUrl?: string;
  thumbnailUrl?: string | null;
}

export interface VideoUploadOptions {
  targetType?: 'story' | 'contest_entry';
  onProgress?: (progress: number) => void;
  /** Abort the upload (screen left, user cancelled). Rejects with UploadCancelledError. */
  signal?: AbortSignal;
}

export async function uploadVideoForEncoding(
  uri: string,
  options: VideoUploadOptions = {},
): Promise<VideoUploadOutcome> {
  const { targetType, onProgress, signal } = options;
  if (signal?.aborted) throw new UploadCancelledError();

  // Wrapped, because a failure HERE is the one failure that carries no
  // information about whether R2 is still an option — nothing exists yet.
  // Everything after this point throws: past this line the encoder is known to
  // be live and the legacy path is therefore closed to video.
  let created: CreateUploadResponse;
  try {
    // `upload: "worker"` tells the server this build speaks the Qencode
    // protocol. Without it a Worker answers as if video were not configured,
    // which is what keeps Bunny-era builds from misreading the response.
    created = (await callApi('createVideoUpload', { upload: 'worker', targetType })) as CreateUploadResponse;
  } catch (error) {
    if (signal?.aborted) throw new UploadCancelledError();
    return { status: 'unavailable', error };
  }
  if (signal?.aborted) throw new UploadCancelledError();

  // Default TRUE so an app talking to a Worker that predates `r2Fallback` keeps
  // its old behaviour rather than refusing an upload that would work.
  if (!created?.configured || !created.videoId || !created.uploadPath) {
    return { status: 'not-configured', r2Fallback: created?.r2Fallback ?? true };
  }

  const playbackUrl = await uploadVideoSource(uri, created.uploadPath, onProgress, { signal });

  return {
    status: 'uploaded',
    provider: 'qencode',
    videoId: created.videoId,
    playbackUrl: playbackUrl || (created.playbackUrl as string),
    thumbnailUrl: created.thumbnailUrl ?? null,
  };
}
