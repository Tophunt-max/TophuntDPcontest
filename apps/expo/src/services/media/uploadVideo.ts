import { uploadToR2 } from '@/src/lib/uploadToR2';
import { uploadVideoToBunny } from '@/src/services/video/bunnyUpload';

/**
 * Upload a video and return the URL to store as its media URL.
 *
 * The client mirror of the Worker's `lib/mediaRouting.ts`: one place that answers
 * "where does a video go", instead of the decision being re-derived at each
 * upload site.
 *
 * It was re-derived at two — `services/contests/uploadMedia.ts` and
 * `app/story/create/index.tsx` — and both had the same shape:
 *
 *     try { const bunny = await uploadVideoToBunny(...); if (bunny) ... }
 *     catch (e) { console.warn('falling back to R2', e); }
 *     if (!mediaUrl) await uploadToR2(uri, 'video/mp4', folder);
 *
 * That treats "Bunny is not set up" and "Bunny is set up and the upload failed"
 * as the same event, and they are opposites. In the first, R2 is the intended
 * destination. In the second, R2 has already stopped accepting video — Bunny
 * being configured is exactly what closes it — so the retry cannot succeed, and
 * the user sees a rejection about file types instead of the real failure. Worse,
 * a transient Bunny error would quietly put a video in the image bucket, which is
 * the thing this whole split exists to prevent.
 *
 * So:
 *  - `not-configured` + `r2Fallback` → R2, deliberately. This is the pre-cutover
 *    path and it is not an error.
 *  - `not-configured` + no fallback  → nothing can accept it. Surface that.
 *  - a thrown error                  → Bunny is live and failed. Propagate it.
 */
export interface UploadVideoOptions {
  /** Bunny library title, and the fallback R2 upload's log label. */
  title?: string;
  targetType?: 'story' | 'contest_entry';
  /** R2 prefix used only on the pre-cutover fallback path. */
  r2Folder: string;
  onProgress?: (progress: number) => void;
}

export async function uploadVideo(uri: string, options: UploadVideoOptions): Promise<string> {
  const { title, targetType, r2Folder, onProgress } = options;

  const outcome = await uploadVideoToBunny(uri, { title, targetType, onProgress });

  if (outcome.status === 'uploaded') return outcome.playbackUrl;

  if (outcome.status === 'unavailable') {
    // The routing question could not be asked. Try R2: before cutover it accepts
    // this and the upload succeeds, which is what the previous catch-all did. If
    // Bunny IS live, R2 answers with a `failed-precondition` and the user sees
    // that rather than a silent success into the wrong bucket.
    console.warn('[uploadVideo] createVideoUpload failed; attempting R2:', outcome.error);
    return (await uploadToR2(uri, 'video/mp4', r2Folder, onProgress)) as string;
  }

  if (!outcome.r2Fallback) {
    // Defensive, and currently unreachable: the server only sends `r2Fallback`
    // when Bunny is unconfigured, which is exactly when R2 still accepts video.
    // What actually stops a stale build writing a video into the image bucket is
    // `assertR2AcceptsKind` rejecting it server-side — this branch would only
    // matter if a future setting closed both paths at once.
    throw new Error('Video uploads are temporarily unavailable. Please try again shortly.');
  }

  // Pre-cutover path. `'video/mp4'` means "a video is expected", not "this file
  // is an mp4" — `uploadToR2` reads the real container from the file header, so an
  // iOS `.mov` is stored as `video/quicktime` rather than being mislabelled.
  return (await uploadToR2(uri, 'video/mp4', r2Folder, onProgress)) as string;
}
