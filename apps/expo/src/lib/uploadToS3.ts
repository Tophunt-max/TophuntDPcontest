// src/lib/uploadToS3.ts
import { API_BASE_URL } from "../services/api";
import { auth } from "../services/firebase/initFirebase";

/**
 * Uploads a local file to Cloudflare R2 THROUGH the Worker (`POST /upload`).
 *
 * Previously the client PUT directly to the R2 S3 endpoint via a presigned URL,
 * which fails in the browser with "Network error during S3 upload / CORS"
 * because R2 has no CORS policy for our web origin. Routing through the Worker
 * (same origin as the API) avoids CORS entirely and works on web + native.
 *
 * Signature is unchanged so all callers keep working.
 *
 * @param uri Local file URI
 * @param fileType MIME type (e.g., 'image/jpeg', 'video/mp4')
 * @param folder Target folder (e.g., 'stories', 'avatars', 'contests')
 * @param onProgress Callback for upload progress (0 to 1)
 */
export async function uploadToS3(
  uri: string,
  fileType: string,
  folder: string = "avatars",
  onProgress?: (progress: number) => void,
): Promise<string> {
  console.log(`[Upload] Starting...`, { uri, fileType, folder });

  // Read the local file into a Blob.
  const fileRes = await fetch(uri);
  if (!fileRes.ok) {
    throw new Error(`Failed to read the selected file (${fileRes.status}).`);
  }
  const blob = await fileRes.blob();
  console.log(`[Upload] Blob ready, size: ${blob.size} bytes`);

  // Attach the Firebase ID token so the Worker can authorize the upload.
  let token = "";
  try {
    token = (await auth.currentUser?.getIdToken()) || "";
  } catch {
    /* proceed without token — Worker will reject if required */
  }

  const url = `${API_BASE_URL}/upload?folder=${encodeURIComponent(folder)}&fileType=${encodeURIComponent(fileType)}`;

  return new Promise<string>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.setRequestHeader("Content-Type", fileType);
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);

    if (typeof onProgress === "function") {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress(event.loaded / event.total);
      };
    }

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const json = JSON.parse(xhr.responseText);
          if (json?.publicUrl) {
            console.log("[Upload] Success:", json.publicUrl);
            resolve(json.publicUrl);
          } else {
            reject(new Error("Upload finished but no file URL was returned."));
          }
        } catch {
          reject(new Error("Received an invalid response from the upload server."));
        }
      } else {
        let msg = `Upload failed (status ${xhr.status}).`;
        try {
          const j = JSON.parse(xhr.responseText);
          msg = j?.error?.message || msg;
        } catch {
          /* keep default */
        }
        console.error(`[Upload] Failed ${xhr.status}:`, xhr.responseText);
        reject(new Error(msg));
      }
    };

    xhr.onerror = () => reject(new Error("Network error during upload. Please check your connection and try again."));
    xhr.ontimeout = () => reject(new Error("Upload timed out. Please try again."));

    xhr.send(blob);
  });
}
