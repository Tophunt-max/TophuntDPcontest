/**
 * R2 object writes and the URL→key mapping that guards deletes.
 *
 * Everything the app uploads goes through `uploadToR2`, which writes via the
 * MEDIA binding from inside the Worker. The client cannot PUT to R2 directly:
 * R2's S3 endpoint has no CORS policy for our origin, and — more importantly —
 * bytes that never pass through us cannot be validated. See `lib/mediaTypes.ts`.
 */
import type { Env } from "../types";
import { httpsError } from "./http";
import {
  ALLOWED_MEDIA_MIME_TYPES,
  IMAGE_MIME_TYPES,
  extensionForMime,
  kindOf,
  sniffMediaMime,
  verifyMediaBytes,
  type MediaKind,
  type MediaMime,
} from "./mediaTypes";

/**
 * Kept as a named export because tests and older call sites refer to it.
 * `lib/mediaTypes.ts` is the source of truth.
 */
export const ALLOWED_MIME_TYPES: readonly string[] = ALLOWED_MEDIA_MIME_TYPES;

/** @deprecated Use `extensionForMime` from `lib/mediaTypes`. */
export const extensionFor = extensionForMime;

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

export type UserUploadFolder = (typeof USER_UPLOAD_FOLDERS)[number];

/**
 * Which media families each destination accepts.
 *
 * The folder allow-list already stopped a user writing into deployment-owned
 * prefixes, but it said nothing about WHAT could land in an allowed prefix — so a
 * video could be stored as an avatar and an avatar as a contest video. Only two
 * places in the product actually play video (stories and contest entries), and
 * everything else is a photograph, so the default is image-only and video is
 * granted explicitly.
 *
 * `deposits` being image-only matters beyond tidiness: an admin opens those to
 * read a UPI reference number off a screenshot, and a 30-second clip in that
 * queue is a way to waste an operator's time and our egress. `avatars` being
 * image-only is what stops an 80 MB "profile picture" that every follower list
 * would then try to fetch.
 */
const MEDIA_KINDS_BY_FOLDER: Record<string, readonly MediaKind[]> = {
  // Feed posts and DMs carry either.
  posts: ["image", "video"],
  chat: ["image", "video"],
  // apps/expo/app/story/create/index.tsx offers both.
  stories: ["image", "video"],
  // Photo battles and video battles share this prefix.
  contests: ["image", "video"],
  "contest-entries": ["image", "video"],
  // Profile imagery.
  avatars: ["image"],
  profile: ["image"],
  // A UPI payment screenshot an admin has to read.
  deposits: ["image"],
  // Abuse-report evidence is a screenshot.
  reports: ["image"],
  // Locally captured composite battle card (src/lib/vsImage.ts) — always JPEG.
  "vs-cards": ["image"],
  // Deployment-owned, written only by the admin routes.
  "contest-banners": ["image"],
  "payment-qr": ["image"],
  // Unclassified fallback: the safe family only.
  misc: ["image"],
};

/**
 * The exact mime types a folder may receive. Unknown folders get images only —
 * failing closed, so adding a folder to `USER_UPLOAD_FOLDERS` without thinking
 * about video cannot silently open a video path.
 */
export function allowedMimesForFolder(folder: string): readonly MediaMime[] {
  const kinds = MEDIA_KINDS_BY_FOLDER[folder] ?? (["image"] as const);
  return ALLOWED_MEDIA_MIME_TYPES.filter((mime) => kinds.includes(kindOf(mime) as MediaKind));
}

/** True when a folder accepts video at all (used for the pre-read size cap). */
export function folderAcceptsVideo(folder: string): boolean {
  return (MEDIA_KINDS_BY_FOLDER[folder] ?? []).includes("video");
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
 * Key layout is unchanged (`{folder}/{images|videos}/{uuid}{ext}`) except that
 * both the `images|videos` segment and the extension are now derived from the
 * detected type, so a URL's extension always matches its content.
 *
 * @param declaredType What the caller claims the body is. Cross-checked for
 *   family agreement only; the detected type wins.
 * @param allowed Exact mime types this destination accepts. Pass a single-entry
 *   list to demand an exact match.
 */
export async function uploadToR2(
  env: Env,
  declaredType: string,
  folder: string,
  body: ArrayBuffer | Uint8Array,
  allowed: readonly string[] = ALLOWED_MEDIA_MIME_TYPES,
): Promise<{ publicUrl: string; fileKey: string; contentType: MediaMime }> {
  const contentType = verifyMediaBytes(body, declaredType, allowed);

  const safeFolder = sanitizeMediaFolder(folder);
  const subFolder = kindOf(contentType) === "video" ? "videos" : "images";
  const fileKey = `${safeFolder}/${subFolder}/${crypto.randomUUID()}${extensionForMime(contentType)}`;

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

  const safeFolder = sanitizeMediaFolder(folder, "blog/imported");
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
 * Return the R2 key for a url that is BOTH owned by this deployment (any of its
 * media bases) and inside `ownedPrefix`, else null.
 *
 * The prefix check is the security property: it is what stops a caller-supplied
 * url from naming an arbitrary object. `fileName` must be a single path segment,
 * so no traversal and no reaching into another prefix.
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

    const fileName = candidate.pathname.slice(prefix.length);
    if (!fileName || fileName.includes("/") || fileName === "." || fileName === "..") continue;
    return `${ownedPrefix}${fileName}`;
  }
  return null;
}

/**
 * Return the R2 key only when a URL is owned by this deployment and lives in
 * the fixed contest-banner image prefix. External URLs and lookalike hosts or
 * paths are never mapped to local objects.
 */
export function contestBannerKeyFromPublicUrl(env: Env, publicUrl: string): string | null {
  return ownedKeyFromPublicUrl(env, publicUrl, "contest-banners/images/");
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
  return ownedKeyFromPublicUrl(env, publicUrl, "vs-cards/images/");
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
