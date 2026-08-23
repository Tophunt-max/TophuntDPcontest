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
 * Returns `null` when Bunny is not configured server-side, which is the signal
 * for callers to fall back to the existing R2 upload path. That keeps the app
 * working before the Bunny account is provisioned.
 */

export interface BunnyUploadResult {
  provider: 'bunny';
  videoId: string;
  /** HLS playlist — store this as the media URL. */
  playbackUrl: string;
  thumbnailUrl: string | null;
}

interface CreateUploadResponse {
  configured: boolean;
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
): Promise<BunnyUploadResult | null> {
  const { title, targetType, onProgress } = options;

  const created = (await callApi('createVideoUpload', {
    title: title || `video-${Date.now()}`,
    targetType,
  })) as CreateUploadResponse;

  // Server says Bunny isn't set up — caller falls back to R2.
  if (!created?.configured || !created.videoId || !created.signature) return null;

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
    provider: 'bunny',
    videoId,
    playbackUrl: playbackUrl as string,
    thumbnailUrl: thumbnailUrl ?? null,
  };
}
