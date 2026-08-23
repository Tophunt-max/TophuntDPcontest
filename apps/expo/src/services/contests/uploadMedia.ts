import { uploadToR2 } from "@/src/lib/uploadToR2";
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
      return (await uploadToR2(uri, 'video/mp4', 'contests', onProgress)) as string;
    }

    return (await uploadToR2(uri, 'image/jpeg', 'contests', onProgress)) as string;
  },
};
