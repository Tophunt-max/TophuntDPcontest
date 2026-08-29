import { Platform } from 'react-native';
import * as tus from 'tus-js-client';

import { callApi } from '../api';
import { tusUrlStorage } from './tusUrlStorage';

/**
 * Resumable video upload direct to Bunny Stream (MEDIA_MIGRATION_PLAN.md 2e).
 *
 * Flow:
 *   createVideoUpload (Worker)  ->  { videoId, libraryId, expirationTime, signature }
 *     -> tus upload to https://video.bunnycdn.com/tusupload
 *     -> videoUploadComplete (Worker) marks the row 'processing'
 *
 * The Bunny API key never reaches this code — the Worker mints a short-lived
 * signature scoped to one video id.
 *
 * Callers should not use this directly — `services/media/uploadVideo.ts` wraps it
 * with the fallback decision, so that decision exists in one place instead of
 * being re-implemented at each upload site.
 */

export interface BunnyUploadResult {
  provider: 'bunny';
  videoId: string;
  /** HLS playlist — store this as the media URL. */
  playbackUrl: string;
  thumbnailUrl: string | null;
}

/**
 * Why this is a discriminated result and not `BunnyUploadResult | null`.
 *
 * `null` meant "not configured", and every caller read it as "use R2". That was
 * right while R2 still accepted video and wrong the moment it stopped: retrying
 * there produces a second, less comprehensible rejection on top of the first.
 * `r2Fallback` is the server's own answer to "is that path still open", so the
 * client stops guessing.
 *
 * A THROWN error means something else entirely: Bunny was configured and the
 * upload itself failed. R2 is closed to video in that state by definition, so
 * there is nothing to fall back to and the error belongs in front of the user.
 * `services/media/uploadVideo.ts` is where that reasoning lives, once.
 */
export type BunnyUploadOutcome =
  | ({ status: 'uploaded' } & BunnyUploadResult)
  | { status: 'not-configured'; r2Fallback: boolean }
  /**
   * Could not even ask the server where this video belongs — `createVideoUpload`
   * itself failed (5xx, dropped connection, token refresh). No Bunny session
   * exists, so this says NOTHING about whether Bunny is live, and the caller is
   * free to try R2.
   *
   * Separated from a thrown error because the old code caught every throw and fell
   * back to R2, and collapsing this case into "Bunny failed, do not retry" turned
   * a transient API blip into a failed story upload — on the pre-cutover
   * deployment, where R2 was going to accept it anyway.
   */
  | { status: 'unavailable'; error: unknown };

interface CreateUploadResponse {
  configured: boolean;
  /** Whether `POST /upload` still accepts video. Absent on older Workers. */
  r2Fallback?: boolean;
  videoId?: string;
  libraryId?: string;
  expirationTime?: number;
  signature?: string;
  tusEndpoint?: string;
  playbackUrl?: string;
  thumbnailUrl?: string | null;
}

export interface BunnyUploadOptions {
  title?: string;
  targetType?: 'story' | 'contest_entry';
  onProgress?: (progress: number) => void;
}

/**
 * Retry schedule from the plan. The long tail matters on Indian mobile data,
 * where a tunnel can drop for tens of seconds before recovering.
 */
const RETRY_DELAYS = [0, 3000, 5000, 10000, 20000, 60000];

export async function uploadVideoToBunny(
  uri: string,
  options: BunnyUploadOptions = {},
): Promise<BunnyUploadOutcome> {
  const { title, targetType, onProgress } = options;

  // Wrapped, because a failure HERE is the one Bunny failure that carries no
  // information about whether R2 is still an option — nothing has been created
  // yet. Everything after this point throws, because past this line Bunny is
  // known to be live and R2 is therefore closed to video.
  let created: CreateUploadResponse;
  try {
    created = (await callApi('createVideoUpload', {
      title: title || `video-${Date.now()}`,
      targetType,
    })) as CreateUploadResponse;
  } catch (error) {
    return { status: 'unavailable', error };
  }

  // Server says Bunny isn't set up. It also says whether R2 will still take the
  // bytes; default TRUE so an app talking to a Worker that predates `r2Fallback`
  // keeps its old behaviour rather than refusing an upload that would work.
  if (!created?.configured || !created.videoId || !created.signature) {
    return { status: 'not-configured', r2Fallback: created?.r2Fallback ?? true };
  }

  const {
    videoId,
    libraryId,
    expirationTime,
    signature,
    tusEndpoint,
    playbackUrl,
    thumbnailUrl,
  } = created;

  const fileRes = await fetch(uri);
  if (!fileRes.ok) throw new Error(`Failed to read the selected video (${fileRes.status}).`);
  const blob = await fileRes.blob();

  await new Promise<void>((resolve, reject) => {
    const upload = new tus.Upload(blob, {
      endpoint: tusEndpoint || 'https://video.bunnycdn.com/tusupload',
      retryDelays: RETRY_DELAYS,
      // Bunny authenticates the TUS session with these four headers; the
      // signature is bound to LibraryId + VideoId + AuthorizationExpire.
      headers: {
        AuthorizationSignature: signature,
        AuthorizationExpire: String(expirationTime),
        LibraryId: String(libraryId),
        VideoId: String(videoId),
      },
      // BOTH of these are mandatory for Bunny — it rejects the upload without
      // filetype, and the dashboard shows an untitled entry without title.
      metadata: {
        filetype: blob.type || 'video/mp4',
        title: title || `video-${videoId}`,
      },
      // Web has localStorage, so tus handles resuming itself there. On native we
      // supply an AsyncStorage-backed store or resuming silently no-ops.
      ...(Platform.OS === 'web' ? {} : { urlStorage: tusUrlStorage }),
      onProgress: (bytesSent, bytesTotal) => {
        if (typeof onProgress === 'function' && bytesTotal > 0) {
          onProgress(bytesSent / bytesTotal);
        }
      },
      onSuccess: () => resolve(),
      onError: (error) => reject(error),
    });

    // Resume rather than restart if this exact file was interrupted before.
    upload
      .findPreviousUploads()
      .then((previous) => {
        if (previous.length > 0) upload.resumeFromPreviousUpload(previous[0]);
        upload.start();
      })
      .catch(() => {
        // A URL-storage failure must not prevent a fresh upload.
        upload.start();
      });
  });

  // Tell the Worker the bytes are in. The authoritative 'ready' transition comes
  // from Bunny's encoding webhook, not from here.
  try {
    await callApi('videoUploadComplete', { videoId, targetType });
  } catch (e) {
    // The webhook still reconciles this, so a failure here is not fatal.
    console.warn('[bunnyUpload] videoUploadComplete failed:', e);
  }

  return {
    status: 'uploaded',
    provider: 'bunny',
    videoId,
    playbackUrl: playbackUrl as string,
    thumbnailUrl: thumbnailUrl ?? null,
  };
}
