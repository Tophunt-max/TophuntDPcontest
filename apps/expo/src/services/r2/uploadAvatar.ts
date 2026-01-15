import { CloudflareMediaService, PhotoDerivatives } from '@/src/services/media/CloudflareMediaService';
import { getAuth } from 'firebase/auth';

/**
 * Uploads optimized profile avatar in multiple sizes
 * Returns derivatives object for Firestore
 */
export const uploadAvatar = async (uri: string): Promise<PhotoDerivatives> => {
  const auth = getAuth();
  const userId = auth.currentUser?.uid;
  
  if (!userId) {
    throw new Error("Authentication required for avatar upload");
  }

  try {
    const derivatives = await CloudflareMediaService.uploadProfileImage(uri, userId);
    return derivatives; 
  } catch (error) {
    console.error("Avatar optimization/upload failed:", error);
    throw error;
  }
};
