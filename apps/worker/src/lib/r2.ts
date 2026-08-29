/**
 * R2 object writes and the URL→key mapping that guards deletes.
 *
 * Everything the app uploads goes through `uploadToR2`, which writes via the
 * MEDIA binding from inside the Worker. The client cannot PUT to R2 directly:
 * R2's S3 endpoint has no CORS policy for our origin, and — more importantly —
 * bytes that never pass through us cannot be validated. See `lib/mediaTypes.ts`.
 *
 * This bucket holds IMAGES. Video lives in Bunny Stream — `lib/mediaRouting.ts`
 * owns that decision, `lib/bunny.ts` implements it. What each prefix is for, who
 * may write it, and how it is cached and expired is declared once in
 * `lib/mediaCategories.ts`; this file no longer keeps its own copy of any of it.
 */
import type { Env } from "../types";
import { httpsError } from "./http";
import {
  ALLOWED_MEDIA_MIME_TYPES,
  IMAGE_MIME_TYPES,
  extensionForMime,
  sniffMediaMime,
  verifyMediaBytes,
  type MediaMime,
} from "./mediaTypes";
import {
  allowedMimesForCategory,
  BANNER_PREFIX,
  BLOG_IMPORT_PREFIX,
  buildMediaKey,
  categoryEverAcceptedVideo,
  isSafeRelativeKey,
  isUserWritablePrefix,
  USER_UPLOAD_PREFIXES,
  VS_CARD_PREFIX,
} from "./mediaCategories";

/**
 * Kept as a named export because tests and older call sites refer to it.
 * `lib/mediaTypes.ts` is the source of truth.
 */
export const ALLOWED_MIME_TYPES: readonly string[] = ALLOWED_MEDIA_MIME_TYPES;

/** @deprecated Use `extensionForMime` from `lib/mediaTypes`. */
export const extensionFor = extensionForMime;

/**
 * Prefixes a normal end user may name as an upload destination.
 *
 * Re-exported from `lib/mediaCategories.ts`, where it is DERIVED from the writer
 * of each category rather than hand-maintained. It used to be a literal array
 * here, and the two times it was wrong were both total, silent outages of a
 * feature: the first version omitted `contests` and `contest-entries`, so every
 * photo and video battle entry was rejected with a 400 and no battle could be
 * created or joined; it also omitted `deposits`, which blocked every manual
 * top-up. Deriving it means adding a category cannot leave the allow-list behind.
 *
 * The name is kept for `routes/upload.ts` and `test/uploadFolders.test.ts`.
 */
export const USER_UPLOAD_FOLDERS = USER_UPLOAD_PREFIXES;

export type UserUploadFolder = string;

/**
 * The exact mime types a folder may receive, ignoring the video provider.
 *
 * Prefer `allowedMimesForUpload` from `lib/mediaRouting.ts` at an upload site:
 * this answers "what is this prefix for", which is images, and knows nothing
 * about whether the legacy R2 video path is still open.
 */
export function allowedMimesForFolder(folder: string): readonly MediaMime[] {
  return allowedMimesForCategory(folder);
}

/**
 * True when a folder could ever hold video. Used ONLY to pick the pre-read size
 * cap, never to authorise — see `assertR2AcceptsKind`.
 */
export function folderAcceptsVideo(folder: string): boolean {
  return categoryEverAcceptedVideo(folder);
}

/** True when `POST /upload` may write to this prefix. */
export function isUserUploadFolder(folder: string): boolean {
  return isUserWritablePrefix(folder);
}

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
 * Upload bytes to R2 through the Worker, storing the type we VERIFIED rather
 * than the one we were told.
 *
 * The signature intentionally takes a buffer and not a `ReadableStream`. It used
 * to accept either, but a stream cannot be inspected without consuming it, and
 * "validate the content" is not an option that can coexist with "stream it
 * straight through". Every caller already had the whole body in memory, bounded
 * by a size cap checked before this point.
 *
 * Validation lives HERE, at the single choke point in front of the bucket,
 * rather than in each route. The previous arrangement had the admin banner route
 * sniffing magic bytes correctly while `/upload` — reachable by every signed-in
 * user — checked only a query string. Putting the check in the shared writer
 * means a future route cannot accidentally skip it.
 *
 * Key layout: `{prefix}/{YYYY}/{MM}/{uuid}{ext}`, built by `buildMediaKey` — see
 * `lib/mediaCategories.ts` for why the month shard is there. The extension comes
 * from the DETECTED type, so a URL's extension always matches its content.
 *
 * The old layout inserted an `images|videos` segment. That segment separated two
 * families which no longer share this bucket, and objects written under it are
 * still served and still deleted correctly — `categoryForKey` and
 * `isSafeRelativeKey` both match on the category prefix, so the two layouts
 * coexist and nothing needed to be moved or rewritten.
 *
 * @param declaredType What the caller claims the body is. Cross-checked for
 *   family agreement only; the detected type wins.
 * @param allowed Exact mime types this destination accepts. Defaults to IMAGES
 *   ONLY — a caller that genuinely still needs the legacy video path has to say
 *   so, which is what stops a new upload site from quietly reopening it. Pass a
 *   single-entry list to demand an exact match.
 */
export async function uploadToR2(
  env: Env,
  declaredType: string,
  folder: string,
  body: ArrayBuffer | Uint8Array,
  allowed: readonly string[] = IMAGE_MIME_TYPES,
): Promise<{ publicUrl: string; fileKey: string; contentType: MediaMime }> {
  const contentType = verifyMediaBytes(body, declaredType, allowed);

  const safeFolder = sanitizeMediaFolder(folder);
  const fileKey = buildMediaKey(safeFolder, extensionForMime(contentType));

  await env.MEDIA.put(fileKey, body, { httpMetadata: { contentType } });

  const publicBase = env.R2_PUBLIC_BASE_URL.replace(/\/$/, "");
  return { fileKey, publicUrl: `${publicBase}/${fileKey}`, contentType };
}

/**
 * Store an image fetched by the server (blog/archive importer) after verifying
 * its bytes, de-duplicated by content hash.
 *
 * The importer previously trusted the remote `Content-Type`, mapped
 * `image/svg+xml` to `.svg`, and fell back to a `.img` extension for anything
 * unrecognised — so a hostile or simply broken archive host could place an SVG,
 * or an arbitrary blob with an arbitrary content type, into our bucket. Both maps
 * (routes/admin.ts and lib/importer.ts) had drifted into duplicates of each
 * other; this replaces them.
 *
 * Returns `null` when the bytes are not a supported raster image, so the
 * importer can skip that one asset and carry on rather than failing an import.
 */
export async function putVerifiedImage(
  env: Env,
  folder: string,
  body: ArrayBuffer,
  contentHash: string,
): Promise<{ publicUrl: string; key: string; cached: boolean; contentType: MediaMime } | null> {
  const detected = sniffImage(body);
  if (!detected) return null;

  // Deliberately NOT `buildMediaKey`: this key is the content hash, which is what
  // makes re-importing the same asset a no-op. A month shard in front of it would
  // give identical bytes a different key each month and turn the dedup below into
  // a slow way of storing duplicates.
  const safeFolder = sanitizeMediaFolder(folder, BLOG_IMPORT_PREFIX);
  const key = `${safeFolder}/${contentHash}${extensionForMime(detected)}`;
  const publicUrl = `${env.R2_PUBLIC_BASE_URL.replace(/\/$/, "")}/${key}`;

  const existing = await env.MEDIA.head(key);
  if (!existing) await env.MEDIA.put(key, body, { httpMetadata: { contentType: detected } });
  return { publicUrl, key, cached: !!existing, contentType: detected };
}

/** Detected type, but only if it is a raster image. */
function sniffImage(body: ArrayBuffer): MediaMime | null {
  const detected = sniffMediaMime(body);
  if (!detected || !(IMAGE_MIME_TYPES as readonly string[]).includes(detected)) return null;
  return detected;
}

/**
 * Every base url whose objects live in OUR bucket: the current
 * `R2_PUBLIC_BASE_URL` first, then anything in `R2_LEGACY_BASE_URLS`.
 *
 * Why this list exists at all
 * ---------------------------
 * `uploadToR2` stores media urls ABSOLUTE in D1. That is the right trade for
 * reads — a row is self-describing and needs no base to render — but it means
 * changing `R2_PUBLIC_BASE_URL` (Worker `/media` proxy → `media.tophunt.in`)
 * does not rewrite a single existing row. Those rows keep LOADING, because the
 * Worker's `/media/*` route stays. What silently stops working is the reverse
 * direction: the url→key mapping every delete path depends on.
 *
 * With a single base, a pre-cutover url matched no base and fell through to a
 * bare-pathname guess, which produced `media/stories/images/x.jpg` for a real
 * key of `stories/images/x.jpg` — a delete that hit nothing and reported
 * success. Banner and battle-card deletes were worse: they compare the host
 * exactly, so they returned `null` and never deleted anything on the old host.
 * The visible symptom is nothing at all, while the bucket keeps growing and
 * media outlives the record that referenced it.
 *
 * Entries are normalised (trailing slashes stripped) and de-duplicated, so
 * listing the current base in `R2_LEGACY_BASE_URLS` too is harmless.
 */
export function ownedMediaBases(env: Env): string[] {
  const configured = [env.R2_PUBLIC_BASE_URL, ...String(env.R2_LEGACY_BASE_URLS ?? "").split(",")];
  const bases: string[] = [];
  for (const entry of configured) {
    const base = String(entry ?? "")
      .trim()
      .replace(/\/+$/, "");
    if (!base || bases.includes(base)) continue;
    try {
      new URL(base);
    } catch {
      continue; // a malformed entry must not break the well-formed ones
    }
    bases.push(base);
  }
  return bases;
}

/**
 * The same object's url on the CURRENT media base, for a url on any base we own.
 * Anything else — third-party hosts, malformed strings — is returned untouched.
 *
 * Why this exists
 * ---------------
 * `ownedMediaBases` fixed the WRITE side of a domain cutover (deletes keep
 * working on both hosts). This is the READ side of the same problem. Urls are
 * stored absolute, so a row written before the cutover still names the Worker
 * proxy, and two things follow from that which no amount of waiting fixes:
 *
 *  1. `/cdn-cgi/image/` cannot resolve on the old base (not a zone root — see
 *     lib/media.ts#transformationsAvailable), so every pre-cutover image was
 *     permanently excluded from Transformations. A 66 KB avatar rendered into a
 *     96px circle, forever, because of where its url happened to point.
 *  2. Every byte still costs a Worker invocation, because it routes through the
 *     `/media/*` proxy instead of the CDN.
 *
 * Both are properties of the STRING, not of the object: the key is identical and
 * the bucket is the same one, so the current base serves the very same bytes.
 * Rewriting at the boundary therefore decouples optimisation and egress cost
 * from `scripts/media-domain-backfill.sql`, which is deliberately manual and may
 * not have run yet. The backfill remains worth running — it makes what is stored
 * canonical, so this function stops being load-bearing — but nothing waits on it.
 *
 * Deliberately narrow: only the `ownedMediaBases` prefixes are rewritten, by
 * plain string surgery. The `*.r2.dev` / `*.r2.cloudflarestorage.com` shapes that
 * `mediaKeyFromPublicUrl` also tolerates are left alone, because recovering a key
 * from those requires percent-decoding, and re-encoding it into a new url is a
 * way to corrupt keys containing `%` or `+` for no benefit — they are rare, and
 * deletes already handle them.
 */
export function canonicalMediaUrl(env: Env, publicUrl: string | null | undefined): string | null | undefined {
  if (!publicUrl || typeof publicUrl !== "string") return publicUrl;

  // NOT `ownedMediaBases()[0]`: that list drops malformed entries, so if
  // R2_PUBLIC_BASE_URL were empty or unparseable the first element would be a
  // LEGACY base and this would rewrite good urls onto the old host — the exact
  // inversion of the intent. Resolve the target independently and bail without it.
  const current = String(env.R2_PUBLIC_BASE_URL ?? "")
    .trim()
    .replace(/\/+$/, "");
  if (!current) return publicUrl;
  try {
    new URL(current);
  } catch {
    return publicUrl;
  }

  for (const base of ownedMediaBases(env)) {
    // The trailing slash matters: without it `https://media.tophunt.in` would
    // also prefix-match a lookalike host like `https://media.tophunt.in.evil.example/x`.
    if (!publicUrl.startsWith(`${base}/`)) continue;
    const key = publicUrl.slice(base.length + 1);
    if (!key) return publicUrl;
    return `${current}/${key}`;
  }
  return publicUrl;
}

/**
 * Return the R2 key for a url that is BOTH owned by this deployment (any of its
 * media bases) and inside `ownedPrefix`, else null.
 *
 * The prefix check is the security property: it is what stops a caller-supplied
 * url from naming an arbitrary object. What follows the prefix is validated by
 * `isSafeRelativeKey` — bounded depth, no `.`/`..`, and a charset with no `/`,
 * `%` or `\` — so there is no traversal and no reaching into another prefix.
 *
 * This used to require a SINGLE path segment. That was equivalent for the old
 * flat layout, but it would reject every date-sharded key, and the failure mode
 * was invisible: `contestBannerKeyFromPublicUrl` would return null, the delete
 * would quietly hit nothing and report success, and every new banner and battle
 * card would leak into the bucket while deleted banners stayed readable.
 */
function ownedKeyFromPublicUrl(env: Env, publicUrl: string, ownedPrefix: string): string | null {
  let candidate: URL;
  try {
    candidate = new URL(publicUrl);
  } catch {
    return null;
  }
  // Credentials, query and fragment are all ways to make a url that LOOKS like
  // one of ours while resolving elsewhere; none of our own urls carry them.
  if (candidate.username || candidate.password || candidate.search || candidate.hash) return null;

  for (const baseUrl of ownedMediaBases(env)) {
    let base: URL;
    try {
      base = new URL(baseUrl);
    } catch {
      continue;
    }
    if (candidate.protocol !== base.protocol || candidate.host !== base.host) continue;

    const prefix = `${base.pathname.replace(/\/+$/, "")}/${ownedPrefix}`;
    if (!candidate.pathname.startsWith(prefix)) continue;

    const rest = candidate.pathname.slice(prefix.length);
    if (!isSafeRelativeKey(rest)) continue;
    return `${ownedPrefix}${rest}`;
  }
  return null;
}

/**
 * Return the R2 key only when a URL is owned by this deployment and lives under
 * the `contest-banners/` prefix. External URLs and lookalike hosts or paths are
 * never mapped to local objects.
 *
 * The gate is the CATEGORY prefix, not `contest-banners/images/`. It has to be:
 * that literal describes one key layout, and a banner written under any other —
 * including every date-sharded one — would map to null and silently never be
 * deleted. Depth and charset after the prefix are bounded by `isSafeRelativeKey`.
 */
export function contestBannerKeyFromPublicUrl(env: Env, publicUrl: string): string | null {
  return ownedKeyFromPublicUrl(env, publicUrl, `${BANNER_PREFIX}/`);
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
 * our bucket under `vs-cards/`. It does NOT prove the pixels are a genuine capture
 * of the battle — a participant can upload any image to that prefix.
 *
 * Gating on the category rather than `vs-cards/images/` grants no extra reach: every
 * key under it is minted server-side by `buildMediaKey`, so a caller cannot name a
 * path we would not have created, and `isSafeRelativeKey` bounds depth and charset.
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
  return ownedKeyFromPublicUrl(env, publicUrl, `${VS_CARD_PREFIX}/`);
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
 * primitive: a url outside `vs-cards/` maps to no key and is ignored.
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

/**
 * The R2 key a media url refers to, or null when the url is not ours.
 *
 * Recognised shapes, in order:
 *  1. Any base in `ownedMediaBases` — the current public base and every legacy
 *     one. This is the case that covers a domain cutover: a url written before
 *     the switch resolves to the same key as one written after it.
 *  2. R2's own endpoints (`*.r2.dev`, `*.r2.cloudflarestorage.com`), for rows
 *     predating a public base being configured at all. The S3-style endpoint
 *     puts the bucket in the path, so that segment is stripped.
 *
 * Anything else returns null DELIBERATELY, where the previous implementation
 * fell back to `new URL(url).pathname` for any host. That fallback was both
 * wrong and unsafe: wrong because a proxied base like `<worker>/media` left the
 * `media/` prefix in the key so the delete missed, and unsafe because it turned
 * a stored third-party url (an external avatar, an imported image) into a key in
 * OUR bucket — a `stories/images/x.jpg` path on any host would delete our object
 * of that name. Failing closed can leak storage; guessing can delete live media
 * belonging to someone else's record.
 */
export function mediaKeyFromPublicUrl(env: Env, publicUrl: string): string | null {
  const url = String(publicUrl ?? "").trim();
  if (!url) return null;

  for (const base of ownedMediaBases(env)) {
    if (url.startsWith(`${base}/`)) {
      const key = url.slice(base.length + 1);
      return key || null;
    }
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  let key = decodeURIComponent(parsed.pathname).replace(/^\/+/, "");
  if (host.endsWith(".r2.cloudflarestorage.com")) {
    const bucket = String(env.R2_BUCKET ?? "");
    if (bucket && key.startsWith(`${bucket}/`)) key = key.slice(bucket.length + 1);
    return key || null;
  }
  if (host.endsWith(".r2.dev")) return key || null;
  return null;
}

/**
 * Delete an object from R2 given its public URL (used by deleteStory).
 *
 * Best-effort by design — a storage cleanup must not fail the caller's request —
 * but an unrecognised url is LOGGED rather than swallowed. The failure mode this
 * whole path has is invisibility: bytes nobody references and nobody is looking
 * for. A log line is what makes a missed base show up as a fixable
 * `R2_LEGACY_BASE_URLS` entry instead of a slow, unexplained storage bill.
 */
export async function deleteByPublicUrl(env: Env, publicUrl: string): Promise<void> {
  const key = mediaKeyFromPublicUrl(env, publicUrl);
  if (!key) {
    if (publicUrl) {
      // Expected for genuinely third-party urls (a Google/Apple sign-in avatar,
      // an imported image left on its origin). Worth a line anyway: if the host
      // IS one of ours, this is the signature of a media base missing from
      // R2_LEGACY_BASE_URLS, and that is otherwise invisible.
      console.warn("[r2] skipping delete — url is not on a known media base", publicUrl);
    }
    return;
  }
  try {
    await env.MEDIA.delete(key);
  } catch (e) {
    console.error("[r2] media delete failed (continuing)", key, e);
  }
}
