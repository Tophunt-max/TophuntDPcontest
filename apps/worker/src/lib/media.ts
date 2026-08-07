/**
 * Image optimization helpers (Instagram-style multi-resolution delivery).
 *
 * Builds Cloudflare Image Resizing variant URLs of the form:
 *   {mediaOrigin}/cdn-cgi/image/width=320,quality=70,format=auto/{path}
 *
 * These are exposed as ADDITIONAL fields (e.g. mediaUrlThumb) alongside the
 * original URL, so the change is non-breaking: the client can switch to the
 * lighter variants for feeds/grids and keep the full-res URL for detail views.
 *
 * Requirement: "Transformations" (Image Resizing) must be enabled on the zone
 * that serves R2_PUBLIC_BASE_URL. Until then, keep using the original URLs.
 * Videos and non-owned URLs (e.g. avatar fallbacks) are returned unchanged.
 */
import type { Env } from "../types";

export interface ImgOpts {
  width?: number;
  height?: number;
  quality?: number;
  fit?: "cover" | "contain" | "scale-down" | "crop" | "pad";
  format?: "auto" | "webp" | "avif";
}

const VIDEO_RE = /\.(mp4|mov|webm|m4v)(\?|$)/i;

/** Build a resized/optimized variant URL for our own media; else return as-is. */
export function imgVariant(env: Env, url: string | null | undefined, opts: ImgOpts): string | null | undefined {
  if (!url || typeof url !== "string") return url;
  const base = (env.R2_PUBLIC_BASE_URL || "").replace(/\/$/, "");
  if (!base || !url.startsWith(base)) return url; // only transform our own media
  if (VIDEO_RE.test(url)) return url; // never transform videos
  if (url.includes("/cdn-cgi/image/")) return url; // already transformed

  const parts = [
    opts.width ? `width=${opts.width}` : null,
    opts.height ? `height=${opts.height}` : null,
    `quality=${opts.quality ?? 80}`,
    `fit=${opts.fit ?? "cover"}`,
    `format=${opts.format ?? "auto"}`,
  ]
    .filter(Boolean)
    .join(",");

  const path = url.slice(base.length); // begins with "/"
  return `${base}/cdn-cgi/image/${parts}${path}`;
}

/** Small square for feeds/grids/avatars. */
export const thumbUrl = (env: Env, url: string | null | undefined) =>
  imgVariant(env, url, { width: 320, quality: 70 });

/** Feed-sized optimized image. */
export const optimizedUrl = (env: Env, url: string | null | undefined) =>
  imgVariant(env, url, { width: 1080, quality: 82 });

/** Tiny avatar variant. */
export const avatarUrl = (env: Env, url: string | null | undefined) =>
  imgVariant(env, url, { width: 128, quality: 75 });

/**
 * Enrich a match participant snapshot (userA/userB JSON) with media variants,
 * without mutating the stored object.
 */
function enrichParticipant(env: Env, p: any): any {
  if (!p || typeof p !== "object") return p;
  return {
    ...p,
    mediaUrlThumb: thumbUrl(env, p.mediaUrl),
    mediaUrlOptimized: optimizedUrl(env, p.mediaUrl),
    profilePicThumb: avatarUrl(env, p.profilePic),
  };
}

/** Add media variants to a mapped match object (non-breaking). */
export function enrichMatchMedia<T extends { userA?: any; userB?: any }>(env: Env, m: T): T {
  return {
    ...m,
    userA: enrichParticipant(env, m.userA),
    userB: enrichParticipant(env, m.userB),
  };
}
