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
import { uploadToR2, ALLOWED_MIME_TYPES } from "../lib/r2";
import { httpsError } from "../lib/http";

// 80 MB hard cap (contest videos are capped at 30s on the client).
const MAX_BYTES = 80 * 1024 * 1024;

export const uploadRoute = new Hono<{ Bindings: Env; Variables: Variables }>();

uploadRoute.use("*", requireAuth);

uploadRoute.post("/", async (c) => {
  const fileType = (c.req.query("fileType") || c.req.header("Content-Type") || "").split(";")[0].trim();
  const folder = c.req.query("folder") || "misc";

  if (!ALLOWED_MIME_TYPES.includes(fileType)) {
    throw httpsError("invalid-argument", "Invalid or missing file type.");
  }

  const buf = await c.req.arrayBuffer();
  if (!buf || buf.byteLength === 0) throw httpsError("invalid-argument", "Empty upload.");
  if (buf.byteLength > MAX_BYTES) throw httpsError("invalid-argument", "File too large (max 80MB).");

  const { publicUrl, fileKey } = await uploadToR2(c.env, fileType, folder, buf);
  // `uploadUrl` mirrored for backward-compat with older callers.
  return c.json({ success: true, publicUrl, fileKey, uploadUrl: publicUrl });
});
