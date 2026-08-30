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
 *  - `unavailable`                   → the question went unanswered. R2 MAY be
 *    right, so it is still tried, but its answer never becomes the user-facing
 *    error — see the branch below for why that distinction is the whole point.
 */

/** Keep `throw` on a value we know is an Error, whatever the transport handed us. */
function asError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(typeof error === 'string' ? error : 'Could not start the video upload.');
}
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
    const cause = asError(outcome.error);
    const status = (outcome.error as { status?: number } | null | undefined)?.status;

    // A 4xx is an ANSWER, not a lost question, and it is specifically an answer
    // from past the `bunnyConfigured()` gate — `createVideoUpload` returns 200
    // with `configured: false` when Bunny is off, so it can only reach a
    // deliberate rejection when Bunny is LIVE. R2 is therefore already closed to
    // video and the fallback cannot succeed. Skipping it matters beyond
    // tidiness: `uploadToR2` sends the entire file before the Worker can refuse
    // it, so the old path pushed a whole video over mobile data to earn a
    // rejection. The rate limit (10 video uploads/hour) lands here.
    if (typeof status === 'number' && status >= 400 && status < 500) throw cause;

    // No response at all (timeout, dropped tunnel) or a 5xx. NOW the routing
    // question is genuinely unanswered, and before cutover R2 is where this
    // belongs — so still try it.
    console.warn('[uploadVideo] createVideoUpload failed; attempting R2:', cause);
    try {
      return (await uploadToR2(uri, 'video/mp4', r2Folder, onProgress)) as string;
    } catch (fallbackError) {
      // Once Bunny is live, R2 replies "Videos are no longer uploaded to this
      // endpoint... Please update the app." That sentence describes OUR routing,
      // aimed at a stale build — and this build is not stale, it asked Bunny
      // first and got no answer. Letting it surface told users to update an
      // already-current app and hid the actual failure, so the original error
      // wins. This is the bug the fallback was written to avoid and then caused.
      console.warn('[uploadVideo] R2 fallback also rejected:', fallbackError);
      throw cause;
    }
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
