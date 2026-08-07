import { uploadPhotoToS3 } from "@/lib/s3-upload";

/**
 * Image upload for the admin panel — now uploads to Cloudflare R2 (via the
 * Worker's presigned URL), NOT Firebase Storage. The exported name/signature is
 * kept so existing callers (app-settings configs, contest create) don't change.
 *
 * `path` (e.g. "onboarding/cover.jpg") maps to an R2 folder; R2 generates the
 * final key and returns a public URL.
 */
export async function uploadToFirebaseStorage(file: File, path: string): Promise<string> {
  const folder = (path && path.includes("/") ? path.split("/")[0] : path) || "admin-uploads";
  return uploadPhotoToS3(file, folder);
}
