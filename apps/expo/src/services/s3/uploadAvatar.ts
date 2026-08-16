// src/services/s3/uploadAvatar.ts
import { uploadToS3 } from '@/src/lib/uploadToS3';

/**
 * Uploads a profile avatar via the Worker's authenticated `POST /upload` proxy
 * (which streams into R2). Used during signup and profile editing.
 *
 * NOTE: despite the "S3" naming, uploads no longer go directly to an S3/R2
 * presigned URL — that failed in the browser with a CORS error. `uploadToS3`
 * now posts to the same-API-origin Worker endpoint instead.
 */
export const uploadAvatarToS3 = async (uri: string): Promise<string> => {
  try {
    const publicUrl = await uploadToS3(uri, 'image/jpeg', 'avatars');
    return publicUrl;
  } catch (error) {
    console.error("Error in uploadAvatarToS3:", error);
    throw error;
  }
};
