import { uploadToS3 } from "@/src/lib/uploadToS3";

/**
 * Contest media upload — streams to Cloudflare R2 via the Worker's authenticated
 * `POST /upload` proxy (NOT a direct S3/R2 presigned PUT, which CORS-fails in the
 * browser). Signature is unchanged so callers (contest photo/video setup) don't
 * need edits.
 */
export const contestMediaService = {
  uploadMedia: async (
    uri: string,
    _contestId: string,
    _userId: string,
    mediaType: 'photo' | 'video',
    onProgress?: (progress: number) => void,
  ): Promise<string> => {
    const fileType = mediaType === 'video' ? 'video/mp4' : 'image/jpeg';
    const publicUrl = await uploadToS3(uri, fileType, 'contests', onProgress);
    return publicUrl as string;
  },
};
