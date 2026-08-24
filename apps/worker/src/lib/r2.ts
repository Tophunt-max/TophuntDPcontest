/**
 * R2 presigned uploads — replaces the AWS S3 presigned-URL pipeline
 * (storage/presignedUrl.ts + stories generateStoryUploadUrl).
 *
 * R2 exposes an S3-compatible API, so we sign a PUT URL with aws4fetch and the
 * client PUTs the file directly. The returned publicUrl is served from the R2
 * public bucket / custom domain (R2_PUBLIC_BASE_URL).
 */
import { AwsClient } from "aws4fetch";
import type { Env } from "../types";
import { httpsError } from "./http";
import { getR2Credentials } from "./integrations";

export const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/quicktime",
];

export function extensionFor(mimeType: string): string {
  switch (mimeType) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "video/mp4":
      return ".mp4";
    case "video/quicktime":
      return ".mov";
    default:
      return "";
  }
}

export interface PresignResult {
  uploadUrl: string;
  fileKey: string;
  publicUrl: string;
}

/**
 * Folders a normal end user is allowed to mint an upload key for.
 *
 * `contest-banners` is deliberately NOT here: those objects are treated as
 * deployment-owned by `contestBannerKeyFromPublicUrl` and are deleted by the
 * contest lifecycle, so letting a user write into that prefix would let them
 * plant or clobber banner objects.
 */
export const USER_UPLOAD_FOLDERS = [
  "posts",
  "stories",
  "avatars",
  "profile",
  "chat",
  // Contest entry media. The client sends "contests" (see
  // apps/expo/src/services/contests/uploadMedia.ts); "contest-entries" is kept
  // for older builds already in the wild that send that instead.
  //
  // These two were MISSING when this allow-list was introduced, which rejected
  // every contest entry upload with a 400 — so no photo or video battle could be
  // created or joined at all. `test/uploadFolders.test.ts` now pins every folder
  // the client actually sends so a folder can never be locked out again.
  "contests",
  "contest-entries",
  // Manual UPI/QR deposit screenshots (apps/expo/app/wallet/deposit.tsx). Also
  // missing, which blocked every manual top-up.
  "deposits",
  "reports",
  // Composite head-to-head battle cards, captured and uploaded by the joining
  // client (see `setMatchVsImage`). Its own prefix rather than reusing `stories`
  // so `vsImageKeyFromPublicUrl` can verify a recorded url really is one of these.
  "vs-cards",
  "misc",
] as const;

/**
 * Normalise a caller-supplied folder into a safe R2 key prefix.
 *
 * Multi-segment prefixes are supported (the blog importer uses
 * `blog/imported`), but every segment is individually sanitised, so `..`,
 * absolute paths, empty segments and encoded traversal all collapse away.
 */
export function sanitizeMediaFolder(folder: unknown, fallback = "misc"): string {
  const raw = typeof folder === "string" ? folder : "";
  const segments = raw
    .split("/")
    .map((segment) => segment.replace(/[^a-zA-Z0-9_-]/g, ""))
    .filter((segment) => segment.length > 0 && segment !== "." && segment !== "..")
    .slice(0, 3);
  return segments.length > 0 ? segments.join("/") : fallback;
}

/**
 * Create a presigned PUT URL for a client-side upload to R2.
 * Keeps the S3 key layout: `{folder}/{images|videos}/{uuid}{ext}`.
 *
 * The folder is validated against `USER_UPLOAD_FOLDERS` rather than being
 * interpolated raw: this endpoint mints a credential that writes to whatever
 * key it is given, so an unsanitised prefix let any authenticated user PUT into
 * deployment-owned paths.
 */
export async function presignUpload(
  env: Env,
  fileType: string,
  folder: string,
  expiresIn = 3600,
): Promise<PresignResult> {
  if (!ALLOWED_MIME_TYPES.includes(fileType)) {
    throw httpsError("invalid-argument", "Invalid file type.");
  }
  // Panel-managed with environment fallback (lib/integrations.ts), so the S3
  // keys can be rotated without a deploy.
  const creds = await getR2Credentials(env);
  if (!creds.accountId || !creds.accessKeyId || !creds.secretAccessKey || !creds.bucket) {
    throw httpsError("internal", "Server storage configuration error.");
  }
  const safeFolder = sanitizeMediaFolder(folder);
  if (!(USER_UPLOAD_FOLDERS as readonly string[]).includes(safeFolder)) {
    throw httpsError(
      "invalid-argument",
      `folder must be one of: ${USER_UPLOAD_FOLDERS.join(", ")}.`,
    );
  }

  const subFolder = fileType.startsWith("video/") ? "videos" : "images";
  const fileKey = `${safeFolder}/${subFolder}/${crypto.randomUUID()}${extensionFor(fileType)}`;

  const client = new AwsClient({
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    region: "auto",
    service: "s3",
  });

  const endpoint = `https://${creds.accountId}.r2.cloudflarestorage.com/${creds.bucket}/${fileKey}`;
  const url = new URL(endpoint);
  url.searchParams.set("X-Amz-Expires", String(expiresIn));

  const signed = await client.sign(url.toString(), {
    method: "PUT",
    headers: { "Content-Type": fileType },
    aws: { signQuery: true },
  });

  const publicBase = env.R2_PUBLIC_BASE_URL.replace(/\/$/, "");
  return {
    uploadUrl: signed.url,
    fileKey,
    publicUrl: `${publicBase}/${fileKey}`,
  };
}

/**
 * Upload bytes to R2 THROUGH the Worker (server-side put via the binding).
 *
 * This is the production upload path: the client sends the file to the Worker
 * (same origin as the API, so no S3/CORS issues in the browser) and we write it
 * to R2 here. Keeps the same `{folder}/{images|videos}/{uuid}{ext}` key layout
 * as the presigned flow, and returns a Worker-served public URL.
 */
export async function uploadToR2(
  env: Env,
  fileType: string,
  folder: string,
  body: ArrayBuffer | ReadableStream,
): Promise<{ publicUrl: string; fileKey: string }> {
  if (!ALLOWED_MIME_TYPES.includes(fileType)) {
    throw httpsError("invalid-argument", "Invalid file type.");
  }
  const safeFolder = sanitizeMediaFolder(folder);
  const subFolder = fileType.startsWith("video/") ? "videos" : "images";
  const fileKey = `${safeFolder}/${subFolder}/${crypto.randomUUID()}${extensionFor(fileType)}`;

  await env.MEDIA.put(fileKey, body, { httpMetadata: { contentType: fileType } });

  const publicBase = env.R2_PUBLIC_BASE_URL.replace(/\/$/, "");
  return { fileKey, publicUrl: `${publicBase}/${fileKey}` };
}

/**
 * Return the R2 key only when a URL is owned by this deployment and lives in
 * the fixed contest-banner image prefix. External URLs and lookalike hosts or
 * paths are never mapped to local objects.
 */
export function contestBannerKeyFromPublicUrl(env: Env, publicUrl: string): string | null {
  try {
    const base = new URL(env.R2_PUBLIC_BASE_URL.replace(/\/$/, ""));
    const candidate = new URL(publicUrl);
    if (candidate.protocol !== base.protocol || candidate.host !== base.host) return null;
    if (candidate.username || candidate.password || candidate.search || candidate.hash) return null;

    const basePath = base.pathname.replace(/\/$/, "");
    const ownedPrefix = `${basePath}/contest-banners/images/`;
    if (!candidate.pathname.startsWith(ownedPrefix)) return null;

    const fileName = candidate.pathname.slice(ownedPrefix.length);
    if (!fileName || fileName.includes("/") || fileName === "." || fileName === "..") return null;
    return `contest-banners/images/${fileName}`;
  } catch {
    return null;
  }
}

/**
 * Return the R2 key only when a URL is a composite battle card uploaded to this
 * deployment.
 *
 * `setMatchVsImage` takes a url from a client and records it as the image BOTH
 * participants' battle stories display, so an unchecked value would let one user
 * make the other user's story render an arbitrary remote image — a defacement
 * primitive, and an off-platform tracking pixel on top. Same host/protocol and
 * fixed-prefix checks as `contestBannerKeyFromPublicUrl`, for the same reason.
 *
 * Note carefully what this does and does not prove. It proves the object lives in
 * our bucket under `vs-cards/images/`. It does NOT prove the pixels are a genuine
 * capture of the battle — a participant can upload any image to that prefix.
 *
 * That residual risk is real and worth stating plainly rather than waving at: the
 * recorded card is what the OTHER participant's story displays, on their own reel,
 * to their own followers, with no attribution to whoever supplied it. It is
 * therefore a story-defacement vector, available only to the one other person in
 * the battle, for the 24h the stories live. It is accepted because closing it
 * needs something the platform does not have (proof that a screenshot depicts what
 * it claims), and bounded by: participant-only, first-writer-wins so it cannot be
 * swapped later, a 30/hour rate limit, and `cron.ts` deleting the object when the
 * stories expire. It is NOT equivalent to a user choosing their own entry photo,
 * which appears attributed to them on their own half of the frame.
 */
export function vsImageKeyFromPublicUrl(env: Env, publicUrl: string): string | null {
  try {
    const base = new URL((env.R2_PUBLIC_BASE_URL || "").replace(/\/$/, ""));
    const candidate = new URL(publicUrl);
    if (candidate.protocol !== base.protocol || candidate.host !== base.host) return null;
    if (candidate.username || candidate.password || candidate.search || candidate.hash) return null;

    const basePath = base.pathname.replace(/\/$/, "");
    const ownedPrefix = `${basePath}/vs-cards/images/`;
    if (!candidate.pathname.startsWith(ownedPrefix)) return null;

    const fileName = candidate.pathname.slice(ownedPrefix.length);
    if (!fileName || fileName.includes("/") || fileName === "." || fileName === "..") return null;
    return `vs-cards/images/${fileName}`;
  } catch {
    return null;
  }
}

/**
 * Discard a battle card that lost the first-writer-wins race.
 *
 * Nothing else will ever clean these up: the story-expiry cron only deletes media
 * for `type = 'user'` stories, so an unrecorded card would sit in the bucket
 * forever, paid for and referenced by nothing. Two participants can plausibly
 * capture at the same moment, so without this every contested battle leaks an
 * object.
 *
 * Best-effort by design — the record already succeeded, and failing the caller's
 * request over a storage cleanup would turn a cost problem into a user-visible
 * one. The prefix check is what keeps this from being a delete-arbitrary-key
 * primitive: a url outside `vs-cards/images/` maps to no key and is ignored.
 */
export async function deleteVsImageByPublicUrl(env: Env, publicUrl: string): Promise<void> {
  const key = vsImageKeyFromPublicUrl(env, publicUrl);
  if (!key) return;
  try {
    await env.MEDIA.delete(key);
  } catch (e) {
    console.error("[r2] discarding a superseded battle card failed (continuing)", key, e);
  }
}

/** Remove a validated, deployment-owned contest banner. R2 failures propagate. */
export async function deleteContestBannerByPublicUrl(env: Env, publicUrl: string): Promise<void> {
  const key = contestBannerKeyFromPublicUrl(env, publicUrl);
  if (!key) return;
  await env.MEDIA.delete(key);

  // Public media is cached separately from R2; clear this colo when available.
  try {
    const cache = (caches as any).default as Cache;
    await cache.delete(new Request(publicUrl, { method: "GET" }));
  } catch (e) {
    console.error("[cache] contest banner edge delete failed (continuing)", key, e);
  }
}

/** Delete an object from R2 given its public URL (used by deleteStory). */
export async function deleteByPublicUrl(env: Env, publicUrl: string): Promise<void> {
  try {
    const base = env.R2_PUBLIC_BASE_URL.replace(/\/$/, "");
    let key = publicUrl.startsWith(base)
      ? publicUrl.slice(base.length + 1)
      : new URL(publicUrl).pathname.replace(/^\//, "");
    // If the path still contains the bucket name (S3-style URL), strip it.
    if (key.startsWith(`${env.R2_BUCKET}/`)) key = key.slice(env.R2_BUCKET.length + 1);
    if (key) await env.MEDIA.delete(key);
  } catch {
    /* best-effort */
  }
}
