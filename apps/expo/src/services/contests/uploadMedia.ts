import { getStorage, ref, uploadBytesResumable, getDownloadURL } from "firebase/storage";
import app from "@/src/services/firebase/initFirebase";

const storage = getStorage(app);

export const contestMediaService = {
  /**
   * Uploads contest media (image or video) to Firebase Storage
   * @param uri - Local URI of the media
   * @param contestId - ID of the contest
   * @param userId - ID of the user
   * @param mediaType - 'photo' or 'video'
   */
  uploadMedia: async (
    uri: string, 
    contestId: string, 
    userId: string, 
    mediaType: 'photo' | 'video'
  ): Promise<string> => {
    try {
      // 1. Fetch the blob from URI
      const response = await fetch(uri);
      const blob = await response.blob();

      // 2. Create a storage reference
      // Path: contests/{contestId}/{userId}_{timestamp}.{ext}
      const extension = mediaType === 'video' ? 'mp4' : 'jpg';
      const storagePath = `contests/${contestId}/${userId}_${Date.now()}.${extension}`;
      const storageRef = ref(storage, storagePath);

      // 3. Upload with metadata
      const metadata = {
        contentType: mediaType === 'video' ? 'video/mp4' : 'image/jpeg',
      };

      const uploadTask = uploadBytesResumable(storageRef, blob, metadata);

      return new Promise((resolve, reject) => {
        uploadTask.on(
          'state_changed',
          (snapshot) => {
            // Hum yahan progress handle kar sakte hain agar zaroorat ho
            const progress = (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
            console.log(`Upload is ${progress}% done`);
          },
          (error) => {
            console.error("Upload failed:", error);
            reject(error);
          },
          async () => {
            // Upload complete, get download URL
            const downloadURL = await getDownloadURL(uploadTask.snapshot.ref);
            resolve(downloadURL);
          }
        );
      });
    } catch (error) {
      console.error("Error in uploadMedia:", error);
      throw error;
    }
  }
};
