/**
 * Media delivery helpers: which URL a client should actually load.
 *
 * Two independent jobs, deliberately separated because they have different
 * prerequisites and different blast radius:
 *
 *  1. `cdnUrl` — move a url onto the CURRENT media base so the CDN serves it
 *     instead of the Worker's `/media/*` proxy. Needs only the R2 custom domain
 *     to be attached. Applies to everything, including video.
 *  2. `imgVariant` (and `thumbUrl` / `optimizedUrl` / `avatarUrl`) — additionally
 *     build a Cloudflare Transformations variant:
 *       {mediaOrigin}/cdn-cgi/image/width=320,quality=70,format=auto/{key}
 *     Needs Transformations enabled on the zone AND `MEDIA_TRANSFORMATIONS=true`.
 *     Images only.
 *
 * Variants are exposed as ADDITIONAL fields (e.g. `mediaUrlThumb`) alongside the
 * original, so adopting them is non-breaking: when the feature is off every
 * helper returns the input unchanged and `mediaUrlThumb === mediaUrl`. The Expo
 * client reads them with an `|| mediaUrl` fallback throughout, which is why
 * flipping the flag needs no app release.
 *
 * Both jobs work on urls stored on ANY base this deployment owns, not just the
 * current one — see `canonicalMediaUrl`. That is what stops a pre-cutover row
 * from being permanently stuck on the Worker proxy while a manual D1 backfill is
 * pending. Third-party urls (a Google sign-in avatar, an imported blog image left
 * on its origin) and videos-for-transformation are returned untouched.
 */
import type { Env } from "../types";
import { canonicalMediaUrl, ownedMediaBases } from "./r2";

export interface ImgOpts {
  width?: number;
  height?: number;
  quality?: number;
  fit?: "cover" | "contain" | "scale-down" | "crop" | "pad";
  format?: "auto" | "webp" | "avif";
}

const VIDEO_RE = /\.(mp4|mov|webm|m4v)(\?|$)/i;

/**
 * Prefixes whose objects are deleted while their urls may still be referenced.
 * These keep their stored url and are never moved or transformed.
 *
 * Cache identity is the reason. `index.ts` serves `contest-banners/images/` with
 * `no-store` and `deleteContestBannerByPublicUrl` purges the colo entry for that
 * exact url, because a banner must stop being visible when its contest is edited
 * or removed. Both mechanisms are keyed to the url as stored: a canonicalised url
 * is a different cache entry that no delete path purges, and a
 * `/cdn-cgi/image/...` variant is a third one. Moving these would trade a Worker
 * invocation for "deleted media is still served", which is not a trade worth
 * making on the two smallest, coldest prefixes in the bucket.
 *
 * NOTE the pre-existing gap this does not close: newly uploaded banners are
 * already written to `R2_PUBLIC_BASE_URL` by `uploadToR2`, so they bypass the
 * `no-store` proxy regardless of anything here. Closing that needs an R2/zone
 * cache rule for the prefix — see PRODUCTION_DOMAINS.md.
 */
const PROXY_ONLY_PREFIXES = ["contest-banners/images/", "vs-cards/images/"] as const;

/** The R2 key, if `url` sits on the current media base; else null. */
function keyOnCurrentBase(env: Env, url: string): { base: string; key: string } | null {
  const base = String(env.R2_PUBLIC_BASE_URL ?? "")
    .trim()
    .replace(/\/+$/, "");
  if (!base) return null;
  const canonical = canonicalMediaUrl(env, url);
  if (typeof canonical !== "string" || !canonical.startsWith(`${base}/`)) return null;
  const key = canonical.slice(base.length + 1);
  if (!key || PROXY_ONLY_PREFIXES.some((p) => key.startsWith(p))) return null;
  return { base, key };
}

/**
 * Serve this url from the CDN rather than a Worker invocation.
 *
 * Independent of `MEDIA_TRANSFORMATIONS` — pointing at the bucket's own domain
 * requires no Transformations, only the custom domain to be attached, and the
 * bytes are identical because it is the same key in the same bucket.
 *
 * This matters most for the case a variant helper can never cover: video. Players
 * always send Range requests, and `index.ts` deliberately bypasses the edge cache
 * for ranged responses (`useEdgeCache = !hasDeletionLifecycle && !ranged`) to
 * avoid caching a 206 body, so on the proxy path every chunk and every seek is an
 * uncached R2 GET plus an invocation. On the custom domain the CDN satisfies
 * ranges itself.
 *
 * ONE THING THIS DEPENDS ON, and it is not visible from here: the R2 bucket needs
 * a CORS policy. The `/media/*` route adds `Access-Control-Allow-Origin: *` itself
 * (`lib/mediaCors.ts`); a custom domain serves whatever the bucket's CORS policy
 * says, which is nothing until one is configured. The only consumer that cares is
 * the WEB VS-card capture — `vsNativeModules.web.ts` draws entry images into a
 * canvas via `html-to-image`, and an image without CORS headers taints the canvas
 * and makes the export throw. It degrades gracefully (the story still renders, the
 * share falls back to a text link) and it already applied to every new upload,
 * since `uploadToR2` has been writing to this base all along — but see
 * PRODUCTION_DOMAINS.md §6a, it is a real pending action. Native capture is
 * unaffected: `react-native-view-shot` copies painted pixels, so CORS never
 * applies.
 */
export function cdnUrl(env: Env, url: string | null | undefined): string | null | undefined {
  if (!url || typeof url !== "string") return url;
  const hit = keyOnCurrentBase(env, url);
  if (!hit) return url;
  return `${hit.base}/${hit.key}`;
}

/**
 * Rewrite our own legacy media hosts to the current base inside a blob of stored
 * HTML (imported blog post bodies embed `<img src>` absolutely).
 *
 * Plain string substitution of a fully-qualified `scheme://host/path/` prefix,
 * deliberately, rather than parsing the HTML: the only thing being replaced is a
 * base this deployment owns, the replacement is another url we own, and both are
 * origin-qualified, so there is no attribute-boundary or quoting subtlety to get
 * wrong and no way for the result to point somewhere new.
 *
 * Only OUR bases are touched. Blog imports are explicitly allowed to leave images
 * on third parties (`lib/importer.ts` falls back to the Wayback/origin url when a
 * fetch-to-R2 fails), and those must be left exactly as stored — they are not in
 * our bucket and nothing here can serve them.
 */
export function canonicalizeMediaHtml(env: Env, html: string | null | undefined): string | null | undefined {
  if (!html || typeof html !== "string") return html;
  const current = String(env.R2_PUBLIC_BASE_URL ?? "")
    .trim()
    .replace(/\/+$/, "");
  if (!current) return html;
  let out = html;
  for (const base of ownedMediaBases(env)) {
    if (base === current) continue;
    out = out.split(`${base}/`).join(`${current}/`);
  }
  return out;
}

/**
 * Can `/cdn-cgi/image/` actually resolve for our media origin?
 *
 * This gate is what makes the variant fields safe for clients to consume. When
 * it returns false every helper below hands back the ORIGINAL url, so
 * `mediaUrlThumb === mediaUrl` and the app can adopt the variant fields today;
 * flipping `MEDIA_TRANSFORMATIONS` turns them into real resized URLs with no
 * client release.
 *
 * Three conditions, all required:
 *  - `MEDIA_TRANSFORMATIONS` is explicitly "true" (opt-in, default off);
 *  - the media origin is not a `*.workers.dev` host — those are not zones, so
 *    Transformations cannot be enabled on them;
 *  - the origin has no path prefix. `/cdn-cgi/image/` is only resolvable at the
 *    ROOT of a zone, so a Worker-proxied base like `https://api.example/media`
 *    would produce `https://api.example/media/cdn-cgi/image/...`, which 404s.
 *    This is why the original variant URLs never worked.
 *
 * The flag is a hard requirement and not merely belt-and-braces: `/cdn-cgi/image/`
 * on a zone WITHOUT Transformations enabled ERRORS rather than falling back to
 * the original, so enabling it in code before the dashboard would turn every
 * thumbnail in the product into a broken image.
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
  const hit = keyOnCurrentBase(env, url);
  if (!hit) return url;
  if (VIDEO_RE.test(hit.key)) return url; // never transform videos
  if (hit.key.startsWith("cdn-cgi/image/")) return url; // already transformed

  const parts = [
    opts.width ? `width=${opts.width}` : null,
    opts.height ? `height=${opts.height}` : null,
    `quality=${opts.quality ?? 80}`,
    `fit=${opts.fit ?? "cover"}`,
    `format=${opts.format ?? "auto"}`,
  ]
    .filter(Boolean)
    .join(",");

  return `${hit.base}/cdn-cgi/image/${parts}/${hit.key}`;
}

/**
 * All three presets constrain WIDTH ONLY and use `scale-down`.
 *
 * Without a `height`, `fit=cover` and `fit=scale-down` produce the identical
 * image whenever the source is wider than the target — cropping needs two
 * dimensions, so there is nothing for `cover` to crop. They differ in exactly one
 * case: when the source is NARROWER than the target, `cover` UPSCALES and
 * `scale-down` leaves it alone.
 *
 * Upscaling is never what a delivery layer wants, and here it was actively
 * counterproductive. Measured on a real portrait contest entry (645x1440), the
 * 1080-wide preset:
 *
 *   fit=cover      → 84436 B   (upscaled to 1080 wide, no new detail)
 *   fit=scale-down → 50638 B   (left at 645 wide, re-encoded to WebP)
 *
 * i.e. the "optimized" variant was 67% LARGER than necessary and blurrier, on the
 * single most common shape in the product — a phone-camera portrait DP. Portrait
 * entries are the norm in a DP contest, so this was the common case, not an edge.
 */

/** Small variant for feed thumbnails, grids and blog cards. */
export const thumbUrl = (env: Env, url: string | null | undefined) =>
  imgVariant(env, url, { width: 320, quality: 70, fit: "scale-down" });

/** Feed-sized optimized image. Never upscaled — see the note above. */
export const optimizedUrl = (env: Env, url: string | null | undefined) =>
  imgVariant(env, url, { width: 1080, quality: 82, fit: "scale-down" });

/** Tiny avatar variant. */
export const avatarUrl = (env: Env, url: string | null | undefined) =>
  imgVariant(env, url, { width: 128, quality: 75, fit: "scale-down" });

/**
 * Enrich a match participant snapshot (userA/userB JSON) with media variants,
 * without mutating the stored object.
 *
 * `mediaUrl` and `profilePic` are themselves canonicalised onto the CDN base.
 * They are the fields a client falls back to when it does not understand the
 * variant fields, and — for a video entry, where no variant is ever built — the
 * only fields there are. Leaving them on the proxy would mean the fallback path
 * and all video kept costing an invocation per request.
 */
function enrichParticipant(env: Env, p: any): any {
  if (!p || typeof p !== "object") return p;
  return {
    ...p,
    mediaUrl: cdnUrl(env, p.mediaUrl),
    profilePic: cdnUrl(env, p.profilePic),
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
