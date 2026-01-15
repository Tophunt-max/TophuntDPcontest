import { CloudflareMediaService, CloudflareUploadType } from '@/src/services/media/CloudflareMediaService';
import { getAuth } from 'firebase/auth';

/**
 * Universal upload function using Cloudflare R2 Worker
 */
export const uploadMedia = async (
  uri: string,
  fileType: 'image' | 'video',
  folder: 'stories' | 'posts' | 'contest_entries' = 'posts',
  onProgress?: (progress: number) => void
): Promise<string> => {
  const auth = getAuth();
  const userId = auth.currentUser?.uid;
  if (!userId) throw new Error("Authentication required");

  try {
    // Map folder to CloudflareUploadType (profiles/stories)
    const cfFolder: CloudflareUploadType = (folder === 'stories' || folder === 'posts' || folder === 'contest_entries') 
      ? 'stories' 
      : 'profiles';

    if (fileType === 'image') {
      return await CloudflareMediaService.uploadImage(uri, userId, cfFolder, onProgress);
    } else {
      // If you decide to support video in the worker later, you can update this.
      return await CloudflareMediaService.uploadImage(uri, userId, cfFolder, onProgress);
    }
  } catch (error) {
    console.error("Media upload to Cloudflare failed:", error);
    throw error;
  }
};

export const contestMediaService = {
  uploadMedia: async (
    uri: string,
    contestId: string,
    userId: string,
    fileType: 'photo' | 'video',
    onProgress?: (progress: number) => void
  ): Promise<string> => {
    const type = fileType === 'photo' ? 'image' : 'video';
    return uploadMedia(uri, type, 'contest_entries', onProgress);
  }
};
