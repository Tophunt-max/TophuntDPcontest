import { uploadToR2 } from "@/src/lib/uploadToR2";
import { optimizeImageForUpload } from "@/src/lib/imageOptimize";
import { uploadVideo } from "@/src/services/media/uploadVideo";

/**
 * Contest media upload.
 *
 * Photos always go to Cloudflare R2 via the Worker's authenticated
 * `POST /upload` proxy (NOT a direct R2 presigned PUT, which CORS-fails in the
 * browser).
 *
 * Videos go to Bunny Stream (resumable TUS upload, adaptive-bitrate playback,
 * generated thumbnails) via `services/media/uploadVideo.ts`, which owns the
 * pre-cutover R2 fallback so this file does not have its own copy of that policy.
 *
 * The return type is a single media URL string, so callers (contest photo/video
 * setup) need no edits. For a Bunny video the URL is the HLS playlist, which is
 * also how the guid is later recovered.
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
      return await uploadVideo(uri, {
        title: `contest-${_contestId || 'entry'}-${Date.now()}`,
        targetType: 'contest_entry',
        r2Folder: 'contests',
        onProgress,
      });
    }

    // Downscale the photo first — contest entries were uploading full-resolution
    // camera images, which is the main reason grids and feeds felt slow.
    const optimized = await optimizeImageForUpload(uri, 'contest');
    return (await uploadToR2(optimized, 'image/jpeg', 'contests', onProgress)) as string;
  },
};
