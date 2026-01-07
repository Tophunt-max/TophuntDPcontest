// src/lib/uploadToS3.ts
import { callApi } from "../services/api";

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
  console.log(`[S3Upload] Starting...`, { uri, fileType, folder });
  
  let result: any;
  try {
      console.log(`[S3Upload] Requesting presigned URL...`);
      // Calling the consolidated API with the 'getPresignedUrl' action
      result = await callApi('getPresignedUrl', { fileType, folder });
      console.log(`[S3Upload] Presigned URL response received:`, result);
  } catch (err: any) {
      console.error("[S3Upload] Failed to get presigned URL:", err);
      throw new Error(`Failed to initialize upload: ${err.message}`);
  }
  
  const { uploadUrl, publicUrl } = result;
  if (!uploadUrl) {
      throw new Error("Cloud Function did not return an upload URL.");
  }

  try {
      console.log(`[S3Upload] Fetching blob from URI: ${uri}`);
      const response = await fetch(uri);
      if (!response.ok) {
          throw new Error(`Failed to fetch local file: ${response.statusText}`);
      }
      const blob = await response.blob();
      console.log(`[S3Upload] Blob created, size: ${blob.size} bytes`);

      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        
        xhr.open("PUT", uploadUrl);
        xhr.setRequestHeader("Content-Type", fileType);

        if (typeof onProgress === 'function') {
          xhr.upload.onprogress = (event) => {
            if (event.lengthComputable) {
              const progress = event.loaded / event.total;
              onProgress(progress);
              console.log(`[S3Upload] Progress: ${Math.round(progress * 100)}%`);
            }
          };
        }

        xhr.onload = () => {
          console.log(`[S3Upload] XHR OnLoad Status: ${xhr.status}`);
          if (xhr.status === 200 || xhr.status === 201 || xhr.status === 204) {
            console.log("[S3Upload] Success! Public URL:", publicUrl);
            resolve(publicUrl);
          } else {
            console.error(`[S3Upload] Upload failed with status ${xhr.status}:`, xhr.responseText);
            reject(new Error(`S3 upload failed with status ${xhr.status}`));
          }
        };

        xhr.onerror = (err) => {
          console.error("[S3Upload] XHR Network Error:", err);
          reject(new Error("Network error during S3 upload. Check CORS settings."));
        };

        xhr.ontimeout = () => {
          console.error("[S3Upload] XHR Timeout");
          reject(new Error("S3 upload timed out."));
        };

        console.log(`[S3Upload] Sending XHR request to S3...`);
        xhr.send(blob);
      });

  } catch (error: any) {
      console.error("[S3Upload] Unexpected error:", error);
      throw error;
  }
}
