/**
 * Responsive image URLs on Cloudflare Image Transformations (Instagram-style).
 *
 * Every image the app draws from our own media host is requested at the size it
 * is DISPLAYED, times the screen's pixel density, rounded UP to one of a small
 * fixed set of widths, with `format=auto` (AVIF / WebP when the device takes it):
 *
 *   https://media.tophunt.in/cdn-cgi/image/width=640,quality=78,fit=scale-down,format=auto/<key>
 *
 * Measured on production: a 41.7 KB avatar is 2.1 KB at 128 and a 342 KB
 * onboarding image is 26.5 KB at 320.
 *
 * WHY A FIXED SET OF WIDTHS (and not the exact pixel size)
 * -------------------------------------------------------
 * Cloudflare bills per UNIQUE transformation (image x parameter string), and
 * every unique string is also its own cache entry. Exact sizes would mint a new
 * variant for every phone width. Four buckets cap it at four per image, and
 * three of them (128 / 320 / 1080) use the EXACT parameter strings the Worker
 * already emits (`apps/worker/src/lib/media.ts` avatarUrl / thumbUrl /
 * optimizedUrl), so a URL built here and one returned by the API are the same
 * cache entry. `test/imageVariants.test.ts` pins that parity.
 *
 * WHAT IS NEVER TRANSFORMED (mirrors the Worker's `imgVariant` rules)
 *  - anything not on our media host (Google avatars, Bunny posters, blog images
 *    left on their origin, local files, data:/blob: urls);
 *  - videos;
 *  - proxy-only prefixes (`vs-cards/`, `contest-banners/`, `product-images/`):
 *    their cache identity and purge are keyed to the exact stored url
 *    (`apps/worker/src/lib/mediaCategories.ts`);
 *  - share / capture paths: a `/cdn-cgi/` variant carries no CORS headers, so
 *    those callers keep using the ORIGINAL (see `src/lib/shareMedia.ts`).
 *
 * Kill switch: `/read/app-config` sends `media.transforms`. When it is false
 * (the zone setting was turned off) every helper returns the original url, with
 * no app release. A variant that fails to load also falls back to the original
 * in `AppImage`.
 *
 * Kept free of react-native imports so it runs in plain Node tests.
 */

/** The current media base (production R2 custom domain, a Cloudflare zone root). */
export const MEDIA_BASE = 'https://media.tophunt.in/';

/** Bases this app also owns; urls on them are moved onto MEDIA_BASE first. */
const LEGACY_BASES = ['https://tophunt-api.weadown-in.workers.dev/media/'];

const PROXY_ONLY_PREFIXES = ['vs-cards/', 'contest-banners/', 'product-images/'];
const VIDEO_RE = /\.(mp4|mov|webm|m4v|m3u8)(\?|#|$)/i;
const CDN_CGI = 'cdn-cgi/image/';

/**
 * Width buckets and the quality used for each. 128 / 320 / 1080 match the
 * Worker presets byte for byte; 640 is the one bucket added on the client, for
 * half-screen battle photos (the most common image in the app).
 */
export const WIDTH_BUCKETS = [128, 320, 640, 1080] as const;
const QUALITY: Record<number, number> = { 128: 75, 320: 70, 640: 78, 1080: 82 };

/**
 * Story photos are drawn full-width in the viewer. One fixed value (rather than
 * the live window width) keeps the viewer and both prefetchers on the SAME url,
 * whatever the window does; anything 360pt+ wide on a 3x screen is the 1080
 * bucket anyway.
 */
export const STORY_IMAGE_WIDTH = 400;

/** The largest variant. Beyond it the original is never worth more bytes on a phone. */
export const MAX_VARIANT_WIDTH = 1080;

/** Densities above 3 add bytes nobody can see. */
const MAX_DPR = 3;

let transformsEnabled = true;

/** Set from app-config (`media.transforms`). Unknown / missing leaves it on. */
export function setImageTransformsEnabled(enabled: boolean | null | undefined): void {
  transformsEnabled = enabled !== false;
}

export function imageTransformsEnabled(): boolean {
  return transformsEnabled;
}

/**
 * The R2 key of one of OUR media urls (original or an existing `/cdn-cgi/`
 * variant), or null when the url is not ours / not transformable.
 */
export function mediaKeyOf(url: string | null | undefined): string | null {
  if (!url || typeof url !== 'string') return null;
  let rest: string | null = null;
  for (const base of [MEDIA_BASE, ...LEGACY_BASES]) {
    if (url.startsWith(base)) {
      rest = url.slice(base.length);
      break;
    }
  }
  if (rest == null) return null;
  rest = rest.split(/[?#]/)[0];
  if (rest.startsWith(CDN_CGI)) {
    // cdn-cgi/image/<options>/<key>
    const afterOpts = rest.indexOf('/', CDN_CGI.length);
    if (afterOpts < 0) return null;
    rest = rest.slice(afterOpts + 1);
  }
  if (!rest || rest.includes('..') || rest.startsWith('cdn-cgi/')) return null;
  return rest;
}

/** Can this url be served as a variant at all? */
export function isTransformable(url: string | null | undefined): boolean {
  const key = mediaKeyOf(url);
  if (!key) return false;
  if (VIDEO_RE.test(key)) return false;
  return !PROXY_ONLY_PREFIXES.some((p) => key.startsWith(p));
}

/**
 * The ORIGINAL url for one of our media urls (undoes a variant, moves a legacy
 * base onto the current one). Anything else is returned unchanged. Use for
 * share / capture / save / zoom.
 */
export function originalImageUrl<T extends string | null | undefined>(url: T): T {
  const key = mediaKeyOf(url);
  if (!key) return url;
  return `${MEDIA_BASE}${key}` as T;
}

/** The bucket for a pixel width: the smallest bucket that is at least as wide. */
export function bucketFor(px: number): number {
  const want = Math.max(1, Math.ceil(px));
  for (const w of WIDTH_BUCKETS) if (w >= want) return w;
  return MAX_VARIANT_WIDTH;
}

/** The variant url at exactly bucket `width` (must be one of WIDTH_BUCKETS). */
function variantAt(key: string, width: number): string {
  return `${MEDIA_BASE}${CDN_CGI}width=${width},quality=${QUALITY[width] ?? 80},fit=scale-down,format=auto/${key}`;
}

/**
 * The url to load for an image displayed `displayWidth` points wide on a screen
 * with pixel ratio `dpr`. Returns the input unchanged when it is not ours, not
 * transformable, transforms are switched off, or no size is known.
 */
export function responsiveImageUrl<T extends string | null | undefined>(
  url: T,
  displayWidth: number | null | undefined,
  dpr = 1,
): T | string {
  if (!url || typeof url !== 'string') return url;
  if (!transformsEnabled || !displayWidth || !(displayWidth > 0)) return url;
  if (!isTransformable(url)) return url;
  const key = mediaKeyOf(url) as string;
  const density = Math.min(Math.max(dpr || 1, 1), MAX_DPR);
  return variantAt(key, bucketFor(displayWidth * density));
}

/**
 * A small, cheap preview of the same image (the 128 bucket, or 320 for large
 * images) to show while the full-size variant loads — the "blurry then sharp"
 * Instagram feel. Null when there is nothing smaller worth showing.
 */
export function previewImageUrl(url: string | null | undefined, displayWidth: number, dpr = 1): string | null {
  if (!url || !transformsEnabled || !isTransformable(url)) return null;
  const main = bucketFor(displayWidth * Math.min(Math.max(dpr || 1, 1), MAX_DPR));
  if (main <= 320) return null;
  const key = mediaKeyOf(url) as string;
  return variantAt(key, main >= 1080 ? 320 : 128);
}
