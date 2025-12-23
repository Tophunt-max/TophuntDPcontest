// src/lib/uploadToS3.ts
import { functions } from "../services/firebase/initFirebase";
import { httpsCallable } from "firebase/functions";

/**
 * Uploads a file to S3 using a pre-signed URL.
 * @param uri Local file URI
 * @param fileType MIME type (e.g., 'image/jpeg', 'video/mp4')
 * @param folder Target folder in S3 (e.g., 'stories', 'avatars')
 * @param onProgress Callback for upload progress (0 to 1)
 */
export async function uploadToS3(
  uri: string, 
  fileType: string, 
  folder: string = "avatars",
  onProgress?: (progress: number) => void
) {
  console.log(`Starting S3 Upload to folder: ${folder}...`, { uri, fileType });
  
  // Call the new dynamic presigned URL generator
  const getPresignedUrl = httpsCallable(functions, "generatePresignedUrl");
  let result: any;
  try {
      result = await getPresignedUrl({ fileType, folder });
  } catch (err: any) {
      console.error("Failed to get presigned URL:", err);
      throw new Error(`Failed to initialize upload: ${err.message}`);
  }
  
  const { uploadUrl, publicUrl } = result.data;

  try {
      const response = await fetch(uri);
      const blob = await response.blob();

      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        
        xhr.open("PUT", uploadUrl);
        xhr.setRequestHeader("Content-Type", fileType);

        if (onProgress) {
          xhr.upload.onprogress = (event) => {
            if (event.lengthComputable) {
              const progress = event.loaded / event.total;
              onProgress(progress);
            }
          };
        }

        xhr.onload = () => {
          if (xhr.status === 200) {
            console.log("S3 Upload Success:", publicUrl);
            resolve(publicUrl);
          } else {
            reject(new Error(`Failed to upload to S3: ${xhr.statusText}`));
          }
        };

        xhr.onerror = () => {
          reject(new Error("Network error during S3 upload"));
        };

        xhr.send(blob);
      });

  } catch (error: any) {
      console.error("Error during upload:", error);
      throw error;
  }
}
