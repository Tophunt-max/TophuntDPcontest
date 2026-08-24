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
 * POST /upload?folder=<folder>&fileType=<mime>
 *   body: raw file bytes
 *   auth: Firebase Bearer token
 *   -> { success, publicUrl, fileKey }
 */
import { Hono } from "hono";
import type { Env, Variables } from "../types";
import { requireAuth } from "../middleware/auth";
import { uploadToR2, ALLOWED_MIME_TYPES, USER_UPLOAD_FOLDERS, sanitizeMediaFolder } from "../lib/r2";
import { httpsError } from "../lib/http";
import { clientIp, rateLimit } from "../lib/rateLimit";

// 80 MB hard cap (contest videos are capped at 30s on the client).
const MAX_BYTES = 80 * 1024 * 1024;

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
  const fileType = (c.req.query("fileType") || c.req.header("Content-Type") || "").split(";")[0].trim();
  const requestedFolder = c.req.query("folder") || "misc";

  if (!ALLOWED_MIME_TYPES.includes(fileType)) {
    throw httpsError("invalid-argument", "Invalid or missing file type.");
  }
  // Constrain the destination prefix to the folders a user may write to, the
  // same allow-list the presigned path uses. Without this a caller chose their
  // own key prefix, including deployment-owned ones like `contest-banners/`.
  const folder = sanitizeMediaFolder(requestedFolder);
  if (!(USER_UPLOAD_FOLDERS as readonly string[]).includes(folder)) {
    throw httpsError("invalid-argument", `folder must be one of: ${USER_UPLOAD_FOLDERS.join(", ")}.`);
  }

  const uid = c.get("user").uid;
  const opts = { failClosed: true };
  await rateLimit(c.env, `upload:${uid}`, UPLOADS_PER_HOUR, 3600, opts);
  await rateLimit(c.env, `upload_day:${uid}`, UPLOADS_PER_DAY, 86_400, opts);
  await rateLimit(c.env, `upload_ip:${clientIp(c.req.raw.headers)}`, UPLOADS_PER_IP_PER_HOUR, 3600, opts);

  const buf = await c.req.arrayBuffer();
  if (!buf || buf.byteLength === 0) throw httpsError("invalid-argument", "Empty upload.");
  if (buf.byteLength > MAX_BYTES) throw httpsError("invalid-argument", "File too large (max 80MB).");

  const { publicUrl, fileKey } = await uploadToR2(c.env, fileType, folder, buf);
  // `uploadUrl` mirrored for backward-compat with older callers.
  return c.json({ success: true, publicUrl, fileKey, uploadUrl: publicUrl });
});
