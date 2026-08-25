import { API_BASE_URL } from "../services/api";
import { auth } from "../services/firebase/initFirebase";
import {
  MAX_IMAGE_BYTES,
  MAX_VIDEO_BYTES,
  SNIFF_BYTES,
  UNSUPPORTED_FILE_MESSAGE,
  kindOf,
  sniffMediaMime,
  tooLargeMessage,
  wrongKindMessage,
} from "./mediaTypes";

/**
 * Uploads a local file to Cloudflare R2 THROUGH the Worker (`POST /upload`).
 *
 * Previously the client PUT directly to the R2 S3-compatible endpoint via a
 * presigned URL, which fails in the browser with "Network error during S3
 * upload / CORS" because R2 has no CORS policy for our web origin. Routing
 * through the Worker (same origin as the API) avoids CORS entirely and works on
 * web + native.
 *
 * Named `uploadToR2` for what it actually does — it was `uploadToS3` in
 * `src/lib/uploadToS3.ts`, which had been misleading since the presigned-S3 path
 * was removed.
 *
 * @param uri Local file URI
 * @param fileType The MIME type the caller EXPECTS. Used to decide whether a
 *   photo or a video is wanted; the type actually sent is read from the file's
 *   own header, so callers do not have to be exact.
 * @param folder Target folder (e.g., 'stories', 'avatars', 'contests')
 * @param onProgress Callback for upload progress (0 to 1)
 */
export async function uploadToR2(
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

  // Identify the file from its own bytes rather than trusting the caller.
  //
  // Two reasons this is here and not only on the server. First, correctness: the
  // contest and story paths hard-coded `video/mp4` for anything the picker called
  // a video, so an iOS `.mov` was uploaded mislabelled — the server now derives
  // the type itself, but sending the truth keeps the two in agreement. Second,
  // feedback: the server rejects a non-media file, and without this the user
  // would sit through the whole upload before seeing the error.
  //
  // This is NOT a security control. It runs on the user's device and can be
  // bypassed; `apps/worker/src/lib/mediaTypes.ts` is what actually enforces it.
  const head = new Uint8Array(await blob.slice(0, SNIFF_BYTES).arrayBuffer());
  const detected = sniffMediaMime(head);
  if (!detected) throw new Error(UNSUPPORTED_FILE_MESSAGE);

  const wanted = kindOf(fileType);
  if (wanted && kindOf(detected) !== wanted) throw new Error(wrongKindMessage(wanted));

  const kind = kindOf(detected)!;
  const maxBytes = kind === "video" ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  if (blob.size > maxBytes) throw new Error(tooLargeMessage(kind));

  if (detected !== fileType) {
    console.log(`[Upload] Declared ${fileType}, detected ${detected} — sending detected type.`);
  }

  // Attach the Firebase ID token so the Worker can authorize the upload.
  let token = "";
  try {
    token = (await auth.currentUser?.getIdToken()) || "";
  } catch {
    /* proceed without token — Worker will reject if required */
  }

  // Send the DETECTED type, not the caller's guess.
  const url = `${API_BASE_URL}/upload?folder=${encodeURIComponent(folder)}&fileType=${encodeURIComponent(detected)}`;

  return new Promise<string>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.setRequestHeader("Content-Type", detected);
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
