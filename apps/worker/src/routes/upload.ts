/**
 * /upload — authenticated media upload proxy.
 *
 * The browser (web build) can't PUT directly to the R2 S3 endpoint because R2
 * has no CORS policy for our origin ("Network error during S3 upload. Check
 * CORS settings."). So instead the client uploads the file to the Worker (same
 * origin as the API — CORS is handled by our own middleware) and we stream it
 * into R2 via the MEDIA binding. Works identically on web, Android and iOS and
 * needs no external R2 CORS configuration.
 *
 * Because the bytes pass through us, this is also the only place they can be
 * inspected — which is the reason the presigned-PUT alternative was removed
 * rather than kept as a fallback. See `lib/mediaTypes.ts` for what is enforced.
 *
 * POST /upload?folder=<folder>&fileType=<mime>
 *   body: raw file bytes
 *   auth: Firebase Bearer token
 *   -> { success, publicUrl, fileKey, contentType }
 *
 * `fileType` is a hint. The stored content type and the key's extension come
 * from the file's magic bytes, so `?fileType=image/png` with a ZIP body is a 400,
 * and an iOS `.mov` declared as `video/mp4` is stored correctly as
 * `video/quicktime`.
 */
import { Hono } from "hono";
import type { Env, Variables } from "../types";
import { requireAuth } from "../middleware/auth";
import {
  uploadToR2,
  USER_UPLOAD_FOLDERS,
  sanitizeMediaFolder,
  allowedMimesForFolder,
  folderAcceptsVideo,
} from "../lib/r2";
import {
  ALLOWED_MEDIA_MIME_TYPES,
  MAX_IMAGE_BYTES,
  MAX_VIDEO_BYTES,
  describe,
  kindOf,
} from "../lib/mediaTypes";
import { httpsError } from "../lib/http";
import { clientIp, rateLimit } from "../lib/rateLimit";

/**
 * Upload budget.
 *
 * This endpoint had NO rate limit while accepting 80 MB per request, so a single
 * authenticated account could drive unbounded R2 storage + egress cost. The
 * limits below are far above any legitimate session (a user posting a story,
 * an avatar and a contest entry) but bound the bill.
 *
 * Fail-closed: an outage of the counter store must not reopen an unmetered
 * write path into our own bucket.
 */
const UPLOADS_PER_HOUR = 60;
const UPLOADS_PER_DAY = 300;
/** Per-IP ceiling, so one device cycling accounts is still bounded. */
const UPLOADS_PER_IP_PER_HOUR = 120;

export const uploadRoute = new Hono<{ Bindings: Env; Variables: Variables }>();

uploadRoute.use("*", requireAuth);

uploadRoute.post("/", async (c) => {
  // Lower-cased because MIME types are case-insensitive and the admin routes
  // already normalised: `IMAGE/JPEG` used to be rejected here and accepted there.
  const declaredType = (c.req.query("fileType") || c.req.header("Content-Type") || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  const requestedFolder = c.req.query("folder") || "misc";

  if (!ALLOWED_MEDIA_MIME_TYPES.includes(declaredType as any)) {
    throw httpsError("invalid-argument", "Invalid or missing file type.");
  }
  // Constrain the destination prefix to the folders a user may write to. Without
  // this a caller chose their own key prefix, including deployment-owned ones
  // like `contest-banners/`.
  const folder = sanitizeMediaFolder(requestedFolder);
  if (!(USER_UPLOAD_FOLDERS as readonly string[]).includes(folder)) {
    throw httpsError("invalid-argument", `folder must be one of: ${USER_UPLOAD_FOLDERS.join(", ")}.`);
  }

  // What this destination accepts. An image-only folder rejects a video here,
  // before we spend memory buffering it.
  const allowed = allowedMimesForFolder(folder);
  if (!allowed.includes(declaredType as any)) {
    throw httpsError(
      "invalid-argument",
      `${folder} accepts ${allowed.map(describe).join(", ")} only.`,
    );
  }

  // Per-family cap instead of one 80 MB limit for everything: an avatar has no
  // business being video-sized.
  const maxBytes = folderAcceptsVideo(folder) && kindOf(declaredType) === "video" ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  const maxLabel = `${Math.round(maxBytes / (1024 * 1024))}MB`;

  // Reject on the declared length first. Reading 200 MB into a Worker only to
  // throw afterwards costs us the bandwidth and the memory either way, and the
  // isolate can be killed before our own check ever runs.
  const contentLength = c.req.header("Content-Length");
  if (contentLength !== undefined) {
    const declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0) {
      throw httpsError("invalid-argument", "Invalid Content-Length.");
    }
    if (declaredBytes > maxBytes) throw httpsError("invalid-argument", `File too large (max ${maxLabel}).`);
  }

  const uid = c.get("user").uid;
  const opts = { failClosed: true };
  await rateLimit(c.env, `upload:${uid}`, UPLOADS_PER_HOUR, 3600, opts);
  await rateLimit(c.env, `upload_day:${uid}`, UPLOADS_PER_DAY, 86_400, opts);
  await rateLimit(c.env, `upload_ip:${clientIp(c.req.raw.headers)}`, UPLOADS_PER_IP_PER_HOUR, 3600, opts);

  const buf = await c.req.arrayBuffer();
  if (!buf || buf.byteLength === 0) throw httpsError("invalid-argument", "Empty upload.");
  if (buf.byteLength > maxBytes) throw httpsError("invalid-argument", `File too large (max ${maxLabel}).`);

  // `uploadToR2` sniffs the magic bytes and stores the type it detects, so the
  // declared type above is only a hint — what actually lands in R2 is decided by
  // the file's own header. A renamed ZIP/HTML/SVG/APK is rejected here.
  const { publicUrl, fileKey, contentType } = await uploadToR2(c.env, declaredType, folder, buf, allowed);
  // `uploadUrl` mirrored for backward-compat with older callers.
  return c.json({ success: true, publicUrl, fileKey, uploadUrl: publicUrl, contentType });
});
