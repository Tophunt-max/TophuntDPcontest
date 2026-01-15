import { useState } from 'react';
import { CloudflareMediaService, CloudflareUploadType } from '../../services/media/CloudflareMediaService';
import { getAuth } from 'firebase/auth';

export const useMediaUpload = () => {
  const [isUploading, setIsUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const uploadImage = async (uri: string, folder: CloudflareUploadType) => {
    const auth = getAuth();
    const userId = auth.currentUser?.uid;
    
    if (!userId) {
      setError("User not authenticated");
      return null;
    }

    setIsUploading(true);
    setProgress(0);
    setError(null);

    try {
      // Note: Cloudflare Worker doesn't give granular progress like XHR for simple fetches,
      // but we can simulate or just keep the state for future multipart implementation.
      const url = await CloudflareMediaService.uploadImage(uri, userId, folder);
      setProgress(1);
      return url;
    } catch (err: any) {
      setError(err.message || "Upload failed");
      return null;
    } finally {
      setIsUploading(false);
    }
  };

  return { uploadImage, isUploading, progress, error };
};
