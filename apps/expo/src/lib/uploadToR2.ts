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
export interface UploadOptions {
  /** Abort the upload (the screen was left, the user cancelled). */
  signal?: AbortSignal;
  /** Extra attempts after a failure that got no answer, a 429 or a 5xx. Default 2. */
  retries?: number;
  /** Fail an attempt that makes no progress for this long. Default 45 s. */
  stallTimeoutMs?: number;
}

/** Thrown when the caller aborted the upload. */
export class UploadCancelledError extends Error {
  constructor() {
    super("Upload cancelled.");
    this.name = "UploadCancelledError";
  }
}

export function isUploadCancelled(error: unknown): boolean {
  return error instanceof UploadCancelledError || (error as any)?.name === "UploadCancelledError";
}

class UploadAttemptError extends Error {
  constructor(message: string, public retryable: boolean) {
    super(message);
  }
}

const DEFAULT_UPLOAD_RETRIES = 2;
const DEFAULT_STALL_TIMEOUT_MS = 45_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One POST. There is deliberately no fixed overall timeout: an 80 MB video on a
 * slow connection can take minutes and still be healthy. The attempt fails if
 * NO bytes move for `stallTimeoutMs`. `xhr.timeout` was never set, so the old
 * `ontimeout` handler never fired and a dead connection hung forever.
 */
function postOnce(
  url: string,
  blob: Blob,
  contentType: string,
  token: string,
  onProgress: ((p: number) => void) | undefined,
  signal: AbortSignal | undefined,
  stallTimeoutMs: number,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    let stall: ReturnType<typeof setTimeout> | null = null;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (stall) clearTimeout(stall);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const armStall = () => {
      if (stall) clearTimeout(stall);
      stall = setTimeout(() => {
        try {
          xhr.abort();
        } catch {
          /* already closed */
        }
        finish(() => reject(new UploadAttemptError("Upload stalled. Please check your connection and try again.", true)));
      }, stallTimeoutMs);
    };
    const onAbort = () => {
      try {
        xhr.abort();
      } catch {
        /* already closed */
      }
      finish(() => reject(new UploadCancelledError()));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    xhr.open("POST", url);
    xhr.setRequestHeader("Content-Type", contentType);
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);

    xhr.upload.onprogress = (event) => {
      armStall();
      if (typeof onProgress === "function" && event.lengthComputable) onProgress(event.loaded / event.total);
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const json = JSON.parse(xhr.responseText);
          if (json?.publicUrl) {
            finish(() => resolve(json.publicUrl));
          } else {
            finish(() => reject(new UploadAttemptError("Upload finished but no file URL was returned.", false)));
          }
        } catch {
          finish(() => reject(new UploadAttemptError("Received an invalid response from the upload server.", false)));
        }
        return;
      }
      let msg = `Upload failed (status ${xhr.status}).`;
      try {
        const j = JSON.parse(xhr.responseText);
        msg = j?.error?.message || msg;
      } catch {
        /* keep default */
      }
      console.error(`[Upload] Failed ${xhr.status}:`, xhr.responseText);
      // 429 / 5xx are the server saying "later"; any other 4xx is a refusal of
      // this file (type, size, rate limit per kind) that a retry cannot change.
      const retryable = xhr.status === 429 || xhr.status >= 500 || xhr.status === 0;
      finish(() => reject(new UploadAttemptError(msg, retryable)));
    };

    xhr.onerror = () =>
      finish(() => reject(new UploadAttemptError("Network error during upload. Please check your connection and try again.", true)));
    xhr.ontimeout = () => finish(() => reject(new UploadAttemptError("Upload timed out. Please try again.", true)));

    armStall();
    xhr.send(blob);
  });
}

export async function uploadToR2(
  uri: string,
  fileType: string,
  folder: string = "avatars",
  onProgress?: (progress: number) => void,
  options: UploadOptions = {},
): Promise<string> {
  const { signal, retries = DEFAULT_UPLOAD_RETRIES, stallTimeoutMs = DEFAULT_STALL_TIMEOUT_MS } = options;
  if (signal?.aborted) throw new UploadCancelledError();
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

  // Send the DETECTED type, not the caller's guess.
  const url = `${API_BASE_URL}/upload?folder=${encodeURIComponent(folder)}&fileType=${encodeURIComponent(detected)}`;

  // Bounded retries for failures that are worth repeating. A repeat after a
  // response that was lost at the very end can store the file twice; the spare
  // object is unreferenced, which costs storage, not correctness.
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) throw new UploadCancelledError();
    // A fresh token per attempt: a long retry can outlive the old one.
    let token = "";
    try {
      token = (await auth.currentUser?.getIdToken()) || "";
    } catch {
      /* proceed without token — Worker will reject if required */
    }
    try {
      const publicUrl = await postOnce(url, blob, detected, token, onProgress, signal, stallTimeoutMs);
      console.log("[Upload] Success:", publicUrl);
      return publicUrl;
    } catch (e) {
      if (isUploadCancelled(e)) throw e;
      lastError = e;
      const retryable = e instanceof UploadAttemptError && e.retryable;
      if (!retryable || attempt === retries) break;
      await sleep(1_000 * 2 ** attempt + Math.random() * 500);
    }
  }
  throw lastError instanceof Error ? new Error(lastError.message) : new Error("Upload failed. Please try again.");
}
