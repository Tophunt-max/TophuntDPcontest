// src/services/s3/uploadAvatar.ts
import { uploadToS3 } from '@/src/lib/uploadToS3';

/**
 * Uploads a profile avatar to S3 using the new generic pre-signed URL logic.
 * This function is used during signup and profile editing.
 */
export const uploadAvatarToS3 = async (uri: string): Promise<string> => {
  try {
    console.log("Starting Avatar upload to S3...");
    
    // We specify 'avatars' as the folder. 
    // The helper will call 'generatePresignedUrl' which puts it in avatars/images/
    const publicUrl = await uploadToS3(uri, 'image/jpeg', 'avatars');
    
    console.log("Avatar upload successful:", publicUrl);
    return publicUrl;
  } catch (error) {
    console.error("Error in uploadAvatarToS3:", error);
    throw error;
  }
};

/**
 * Legacy placeholder - can be removed once sure no other parts call it.
 */
export const generateUploadUrl = async (fileType: string) => {
    return { uploadUrl: '', fileKey: '' };
}
