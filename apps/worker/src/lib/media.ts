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
 * that serves R2_PUBLIC_BASE_URL, and that origin must be a zone root — see
 * `transformationsAvailable()`. Until then every helper returns the original
 * URL unchanged, which is what makes these fields safe to consume.
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

/**
 * Can `/cdn-cgi/image/` actually resolve for our media origin?
 *
 * This gate is what makes the variant fields safe for clients to consume. When
 * it returns false every helper below hands back the ORIGINAL url, so
 * `mediaUrlThumb === mediaUrl` and the app can adopt the variant fields today;
 * flipping `MEDIA_TRANSFORMATIONS` at domain cutover turns them into real
 * resized URLs with no client release.
 *
 * Three conditions, all required:
 *  - `MEDIA_TRANSFORMATIONS` is explicitly "true" (opt-in, default off);
 *  - the media origin is not a `*.workers.dev` host — those are not zones, so
 *    Transformations cannot be enabled on them;
 *  - the origin has no path prefix. `/cdn-cgi/image/` is only resolvable at the
 *    ROOT of a zone, so a Worker-proxied base like `https://api.example/media`
 *    would produce `https://api.example/media/cdn-cgi/image/...`, which 404s.
 *    This is why the existing variant URLs never worked.
 */
export function transformationsAvailable(env: Env): boolean {
  if (String(env.MEDIA_TRANSFORMATIONS ?? "").trim().toLowerCase() !== "true") return false;
  try {
    const base = new URL((env.R2_PUBLIC_BASE_URL || "").replace(/\/$/, ""));
    if (base.hostname.endsWith(".workers.dev")) return false;
    if (base.pathname && base.pathname !== "/") return false;
    return true;
  } catch {
    return false;
  }
}

/** Build a resized/optimized variant URL for our own media; else return as-is. */
export function imgVariant(env: Env, url: string | null | undefined, opts: ImgOpts): string | null | undefined {
  if (!url || typeof url !== "string") return url;
  if (!transformationsAvailable(env)) return url; // see transformationsAvailable
  const base = (env.R2_PUBLIC_BASE_URL || "").replace(/\/$/, "");
  // Only the CURRENT base, deliberately — not the legacy bases from
  // R2_LEGACY_BASE_URLS. Those are Worker-proxied paths on hosts where
  // /cdn-cgi/image/ cannot resolve, so building a variant for them would 404.
  // A pre-cutover row therefore keeps serving its original until
  // scripts/media-domain-backfill.sql rewrites it onto the media domain.
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
