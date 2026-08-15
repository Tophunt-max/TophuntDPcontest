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
 * Create a presigned PUT URL for a client-side upload to R2.
 * Keeps the S3 key layout: `{folder}/{images|videos}/{uuid}{ext}`.
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
  if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.R2_BUCKET) {
    throw httpsError("internal", "Server storage configuration error.");
  }

  const subFolder = fileType.startsWith("video/") ? "videos" : "images";
  const fileKey = `${folder}/${subFolder}/${crypto.randomUUID()}${extensionFor(fileType)}`;

  const client = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    region: "auto",
    service: "s3",
  });

  const endpoint = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET}/${fileKey}`;
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
  const safeFolder = (folder || "misc").replace(/[^a-zA-Z0-9_-]/g, "") || "misc";
  const subFolder = fileType.startsWith("video/") ? "videos" : "images";
  const fileKey = `${safeFolder}/${subFolder}/${crypto.randomUUID()}${extensionFor(fileType)}`;

  await env.MEDIA.put(fileKey, body, { httpMetadata: { contentType: fileType } });

  const publicBase = env.R2_PUBLIC_BASE_URL.replace(/\/$/, "");
  return { fileKey, publicUrl: `${publicBase}/${fileKey}` };
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
