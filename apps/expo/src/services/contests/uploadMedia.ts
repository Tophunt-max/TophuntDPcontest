import { uploadToR2 } from "@/src/lib/uploadToR2";
import { optimizeImageForUpload } from "@/src/lib/imageOptimize";
import { uploadVideoToBunny } from "@/src/services/video/bunnyUpload";

/**
 * Contest media upload.
 *
 * Photos always go to Cloudflare R2 via the Worker's authenticated
 * `POST /upload` proxy (NOT a direct R2 presigned PUT, which CORS-fails in the
 * browser).
 *
 * Videos prefer Bunny Stream (resumable TUS upload, adaptive-bitrate playback,
 * generated thumbnails). If Bunny is not configured server-side,
 * `uploadVideoToBunny` returns null and we fall back to the R2 path, so this
 * works both before and after the Bunny account is provisioned.
 *
 * The return type is unchanged — a single media URL string — so callers
 * (contest photo/video setup) need no edits. For a Bunny video the URL is the
 * HLS playlist, which is also how the guid is later recovered.
 */
export const contestMediaService = {
  uploadMedia: async (
    uri: string,
    _contestId: string,
    _userId: string,
    mediaType: 'photo' | 'video',
    onProgress?: (progress: number) => void,
  ): Promise<string> => {
    if (mediaType === 'video') {
      try {
        const bunny = await uploadVideoToBunny(uri, {
          title: `contest-${_contestId || 'entry'}-${Date.now()}`,
          targetType: 'contest_entry',
          onProgress,
        });
        if (bunny) return bunny.playbackUrl;
      } catch (e) {
        // A Bunny failure should not block a contest entry — fall through to R2
        // rather than failing the whole submission.
        console.warn('[contestMedia] Bunny upload failed, falling back to R2:', e);
      }
      // 'video/mp4' here means "a video is expected", not "this file is an mp4".
      // uploadToR2 reads the real container from the file header, so an iOS .mov
      // is now uploaded and stored as video/quicktime instead of being
      // mislabelled as mp4.
      return (await uploadToR2(uri, 'video/mp4', 'contests', onProgress)) as string;
    }

    // Downscale the photo first — contest entries were uploading full-resolution
    // camera images, which is the main reason grids and feeds felt slow.
    const optimized = await optimizeImageForUpload(uri, 'contest');
    return (await uploadToR2(optimized, 'image/jpeg', 'contests', onProgress)) as string;
  },
};
