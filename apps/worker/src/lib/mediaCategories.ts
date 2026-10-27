/**
 * The R2 bucket's table of contents.
 *
 * Every prefix that may exist in `tophunt-media`, who is allowed to write it,
 * how it must be cached, and how long it is kept. This is deliberately ONE table
 * rather than the four parallel structures it replaces — `USER_UPLOAD_FOLDERS`,
 * `MEDIA_KINDS_BY_FOLDER`, the `PROXY_ONLY_PREFIXES` list in `lib/media.ts`, and
 * the `"contest-banners/images/"` string literal that appeared, spelled out by
 * hand, in `lib/r2.ts`, `lib/media.ts` and `src/index.ts`.
 *
 * Those four had already drifted apart. `contest-banners` was excluded from the
 * user allow-list but still needed a hard-coded prefix in three other files to
 * get its cache policy right, and `payment-qr` existed only as an argument at one
 * call site — it appeared in no list at all, so nothing in the codebase stated
 * that it was a real prefix in the bucket. A prefix that is not written down is a
 * prefix nobody can write a lifecycle rule for.
 *
 * ---------------------------------------------------------------------------
 * USER PREFIXES ARE IMAGES ONLY
 * ---------------------------------------------------------------------------
 * Every user-written category is `["image"]`. Video is never stored as uploaded:
 * it goes through the Qencode pipeline (`lib/qencode.ts`), whose two prefixes
 * below — `video-src/` (raw upload) and `videos/` (encoded HLS) — are written by
 * the server only. See `lib/mediaRouting.ts` for the switch and
 * MEDIA_ARCHITECTURE.md for why.
 *
 * `legacyVideo` marks the categories that accepted raw video BEFORE that split,
 * and exists only so the legacy path keeps working until Qencode is live. It is
 * a dated concession, not a property of the category: once
 * `integrations.video.provider` is `"qencode"` in production and no build old
 * enough to POST a video to `/upload` is still installed, every `legacyVideo`
 * flag and the branch in `allowedMimesForCategory` that reads it can be deleted
 * in one commit.
 */
import type { MediaKind, MediaMime } from "./mediaTypes";
import { ALLOWED_MEDIA_MIME_TYPES, IMAGE_MIME_TYPES, kindOf } from "./mediaTypes";

/**
 * Who may create objects under a prefix.
 *
 * - `user`   — any authenticated account, via `POST /upload`.
 * - `admin`  — a full admin only, via the `/admin/media/*` routes. These are
 *              deployment-owned: a user who could write here could plant or
 *              clobber a banner or a payment QR code, which are shown to
 *              everyone and are trusted by the people looking at them.
 * - `server` — written only by the Worker itself (the blog importer, the VS
 *              card renderer, the video pipeline) or by Qencode on its behalf.
 *              Never reachable from `POST /upload`.
 */
export type MediaWriter = "user" | "admin" | "server";

/**
 * How `/media/*` and the CDN must cache a prefix.
 *
 * - `immutable` — the key contains a UUID or a content hash, so the bytes behind
 *                 it never change. Safe to cache for a year.
 * - `no-store`  — the object has a deletion lifecycle and its URL may still be
 *                 referenced after it is gone. A removed contest banner that
 *                 stayed cached would remain public in another colo for up to a
 *                 year, which is why this exists.
 */
export type CachePolicy = "immutable" | "no-store";

export interface MediaCategory {
  /** R2 key prefix. May contain a slash (`blog/imported`). */
  readonly prefix: string;
  readonly writer: MediaWriter;
  /** Families this prefix may contain. Image-only for every user prefix. */
  readonly kinds: readonly MediaKind[];
  readonly cache: CachePolicy;
  /**
   * Intended R2 lifecycle rule, in days, or `null` to keep forever.
   *
   * NOT enforced by this code — R2 lifecycle rules are configured on the bucket.
   * This field is the documented intent so the dashboard and the codebase can be
   * checked against each other; MEDIA_ARCHITECTURE.md lists the rules to apply.
   *
   * A number here means the product ALREADY deletes these objects on a shorter
   * clock (a cron sweep), and the lifecycle rule is a safety net for whatever the
   * sweep missed. It is never the primary deletion mechanism, because a lifecycle
   * rule cannot also clear the D1 row that points at the object.
   */
  readonly retentionDays: number | null;
  /**
   * Whether new keys under this prefix get a `{YYYY}/{MM}` shard.
   *
   * Off for content-hash-keyed prefixes: the hash IS the key, and putting a date
   * in front of it would give the same bytes a different key each month, which
   * defeats the deduplication that prefix exists for.
   */
  readonly dateSharded: boolean;
  /** Accepted raw video before the Qencode split. Temporary — see the file header. */
  readonly legacyVideo: boolean;
  /**
   * Keep serving this prefix through the Worker's `/media/*` route; never
   * canonicalise its URL onto the CDN base and never emit a transformed variant.
   *
   * Cache IDENTITY is the reason, not performance: a canonicalised URL is a
   * different cache entry from the stored one, and a `/cdn-cgi/image/...` variant
   * is a third. Anything that deletes or purges by exact URL only works if the URL
   * never moves.
   *
   * For `contest-banners` that pairs with `cache: "no-store"` and the colo purge in
   * `deleteContestBannerByPublicUrl`, so an edited contest's banner really does
   * stop being visible.
   *
   * `vs-cards` is proxy-only for URL stability alone — it is `immutable`, so a
   * captured card URL can still be served from cache after the 24h cron deletes the
   * object. That is pre-existing behaviour, not something this field introduces;
   * see the known-gaps section of MEDIA_ARCHITECTURE.md.
   *
   * Only worth it where the object can disappear under a live reference. `stories`
   * are also cron-deleted but hot and numerous, so they take the CDN path; these
   * two are the smallest, coldest prefixes in the bucket, which is what makes
   * paying a Worker invocation the right trade here and the wrong one there.
   */
  readonly proxyOnly: boolean;
  readonly description: string;
}

/**
 * Prefixes that other modules name directly, rather than only looking them up.
 *
 * These four are referenced by identity — a banner's cache policy, the gate that
 * proves a client-supplied URL really is a battle card, the importer's default
 * destination — so they get constants instead of being spelled out at each site.
 * `"contest-banners/images/"` was previously written by hand in three separate
 * files, which is exactly the arrangement that makes a layout change silently
 * incorrect in two of them.
 */
export const BANNER_PREFIX = "contest-banners";
/** Photos of the physical products a contest can award (migration 0042). */
export const PRODUCT_IMAGE_PREFIX = "product-images";
export const VS_CARD_PREFIX = "vs-cards";
export const PAYMENT_QR_PREFIX = "payment-qr";
/** Images for the app's first-launch intro, set from the admin panel. */
export const ONBOARDING_IMAGE_PREFIX = "onboarding";
/** Promo banners for the Explore page carousel, set from the admin panel. */
export const EXPLORE_BANNER_PREFIX = "explore-banners";
export const BLOG_IMPORT_PREFIX = "blog/imported";
/** Encoded video (HLS + poster), one folder per video. See lib/qencode.ts. */
export const VIDEO_PREFIX = "videos";
/** Raw video uploads waiting to be encoded. See lib/qencode.ts. */
export const VIDEO_SOURCE_PREFIX = "video-src";

/**
 * Ordered for readability, not for lookup — `categoryForKey` matches on longest
 * prefix so the order here does not affect behaviour.
 */
export const MEDIA_CATEGORIES: readonly MediaCategory[] = [
  // --- Profile imagery -----------------------------------------------------
  {
    prefix: "avatars",
    writer: "user",
    kinds: ["image"],
    cache: "immutable",
    retentionDays: null,
    dateSharded: true,
    legacyVideo: false,

    proxyOnly: false,
    description: "Profile pictures. Image-only is what stops an 80 MB 'avatar' that every follower list then fetches.",
  },
  {
    prefix: "profile",
    writer: "user",
    kinds: ["image"],
    cache: "immutable",
    retentionDays: null,
    dateSharded: true,
    legacyVideo: false,

    proxyOnly: false,
    description: "Other profile imagery (covers).",
  },

  // --- User content -------------------------------------------------------
  {
    prefix: "posts",
    writer: "user",
    kinds: ["image"],
    cache: "immutable",
    retentionDays: null,
    dateSharded: true,
    legacyVideo: true,

    proxyOnly: false,
    description: "Feed post images.",
  },
  {
    prefix: "stories",
    writer: "user",
    kinds: ["image"],
    cache: "immutable",
    // Stories expire after 24h and `cron.ts` deletes the media for `type='user'`
    // rows. 30 days is the net under that sweep, not a replacement for it.
    retentionDays: 30,
    dateSharded: true,
    legacyVideo: true,

    proxyOnly: false,
    description: "Story photos. Expire in 24h; media swept by the story-expiry cron.",
  },
  {
    prefix: "chat",
    writer: "user",
    kinds: ["image"],
    cache: "immutable",
    retentionDays: null,
    dateSharded: true,
    legacyVideo: true,

    proxyOnly: false,
    description: "Images sent in DMs.",
  },

  // --- Contests -----------------------------------------------------------
  {
    prefix: "contests",
    writer: "user",
    kinds: ["image"],
    cache: "immutable",
    retentionDays: null,
    dateSharded: true,
    legacyVideo: true,

    proxyOnly: false,
    description: "Contest entry photos, both photo and video battles. What the current client sends.",
  },
  {
    prefix: "contest-entries",
    writer: "user",
    kinds: ["image"],
    cache: "immutable",
    retentionDays: null,
    dateSharded: true,
    legacyVideo: true,

    proxyOnly: false,
    description: "Legacy alias for `contests`, kept for builds already in the wild that send it.",
  },
  {
    prefix: VS_CARD_PREFIX,
    // SERVER-written since migration 0055: lib/vsPublication.ts composes the card
    // from the two accepted entries at `vs-cards/battles/<matchId>-v<N>.jpg`. Clients
    // may no longer upload here, which closes the old "a participant can put any
    // image on the opponent's story" gap instead of merely bounding it.
    writer: "server",
    kinds: ["image"],
    cache: "immutable",
    // Deleted by the reference-aware sweep (lib/matchStories.ts) once no live
    // story of the battle references the card; the 7-day lifecycle rule is the
    // safety net. Its own prefix is what lets `vsImageKeyFromPublicUrl` scope
    // every delete path to battle cards only.
    retentionDays: 7,
    dateSharded: true,
    legacyVideo: false,

    proxyOnly: true,
    description: "Composite head-to-head battle cards, rendered server-side (Images binding). Always JPEG.",
  },

  // --- Operational --------------------------------------------------------
  {
    prefix: "deposits",
    writer: "user",
    kinds: ["image"],
    cache: "immutable",
    // Deliberately null. These are the evidence behind a manual money movement;
    // deleting one while a dispute or chargeback is open would destroy the only
    // proof of it. A retention rule here is a finance/legal decision, not a
    // storage-cost one — see MEDIA_ARCHITECTURE.md.
    retentionDays: null,
    dateSharded: true,
    legacyVideo: false,

    proxyOnly: false,
    description: "Manual UPI/QR deposit screenshots. An admin reads a reference number off these, which is also why video is refused: a clip in that queue wastes an operator's time and our egress.",
  },
  {
    prefix: "reports",
    writer: "user",
    kinds: ["image"],
    cache: "immutable",
    // Also null, for the same class of reason: this is moderation evidence.
    retentionDays: null,
    dateSharded: true,
    legacyVideo: false,

    proxyOnly: false,
    description: "Abuse-report evidence screenshots.",
  },
  {
    prefix: "misc",
    writer: "user",
    kinds: ["image"],
    cache: "immutable",
    retentionDays: null,
    dateSharded: true,
    legacyVideo: false,

    proxyOnly: false,
    description: "Unclassified fallback. Image-only, so an unrecognised folder cannot open a video path.",
  },

  // --- Deployment-owned ---------------------------------------------------
  {
    prefix: BANNER_PREFIX,
    writer: "admin",
    kinds: ["image"],
    // The one prefix with a real deletion lifecycle: a banner must stop being
    // visible when its contest is edited or deleted.
    cache: "no-store",
    retentionDays: null,
    dateSharded: true,
    legacyVideo: false,

    proxyOnly: true,
    description: "Contest banners, set from the admin panel. Deleted by the contest lifecycle.",
  },
  {
    prefix: PRODUCT_IMAGE_PREFIX,
    writer: "admin",
    kinds: ["image"],
    // Same lifecycle as a banner — it must stop being visible when the contest that
    // advertised it is edited or deleted — with one difference that matters: a
    // product image is COPIED onto every prize_claims row at settlement, so the
    // object has to outlive the contest for as long as a claim references it. The
    // attachment check in routes/admin.ts scans claims as well as contests.
    cache: "no-store",
    retentionDays: null,
    dateSharded: true,
    legacyVideo: false,
    proxyOnly: true,
    description: "Photos of physical prizes, set from the admin panel. Referenced by prize claims.",
  },
  {
    prefix: PAYMENT_QR_PREFIX,
    writer: "admin",
    kinds: ["image"],
    cache: "immutable",
    retentionDays: null,
    dateSharded: true,
    legacyVideo: false,

    proxyOnly: false,
    description: "Manual payment QR code shown on the deposit screen.",
  },
  {
    prefix: ONBOARDING_IMAGE_PREFIX,
    writer: "admin",
    kinds: ["image"],
    // Every upload gets a new key, and the app config names the exact object,
    // so an image never changes in place.
    cache: "immutable",
    retentionDays: null,
    dateSharded: true,
    legacyVideo: false,
    proxyOnly: false,
    description: "Slide images for the first-launch intro (onboarding), set from the admin panel.",
  },
  {
    prefix: EXPLORE_BANNER_PREFIX,
    writer: "admin",
    kinds: ["image"],
    // New key per upload; appConfig.explore.banners names the exact object.
    cache: "immutable",
    retentionDays: null,
    dateSharded: true,
    legacyVideo: false,
    proxyOnly: false,
    description: "Promo banners for the Explore page carousel, set from the admin panel.",
  },

  // --- Server-written -----------------------------------------------------
  {
    prefix: BLOG_IMPORT_PREFIX,
    writer: "server",
    kinds: ["image"],
    cache: "immutable",
    retentionDays: null,
    // Keyed by sha256 for deduplication — see `dateSharded` on the interface.
    dateSharded: false,
    legacyVideo: false,

    proxyOnly: false,
    description: "Images pulled in by the blog/archive importer, keyed by content hash.",
  },
  {
    prefix: VIDEO_PREFIX,
    // Written by Qencode with the R2 credentials the Worker hands it per job, and
    // deleted by `deleteVideoObjects`. Never by a client.
    writer: "server",
    kinds: ["video"],
    // Every object lives in a folder named by a fresh uuid and is written once,
    // when the encode finishes.
    cache: "immutable",
    retentionDays: null,
    // `videos/<uuid>/playlist.m3u8`, `videos/<uuid>/video_1/…`. The uuid folder
    // is the unit of deletion, so no month shard in front of it.
    dateSharded: false,
    legacyVideo: false,
    proxyOnly: false,
    description: "Encoded video: HLS playlist, renditions and a poster per video id. Story and contest video URLs point here.",
  },
  {
    prefix: VIDEO_SOURCE_PREFIX,
    // Written by `POST /upload/video` after the bytes are verified as a video.
    writer: "server",
    kinds: ["video"],
    // Never meant to be served: Qencode reads it through a presigned URL.
    cache: "no-store",
    // Deleted as soon as the encode is ready or failed; the reconcile cron fails
    // and deletes uploads that never finish. 2 days is the safety net.
    retentionDays: 2,
    dateSharded: false,
    legacyVideo: false,
    proxyOnly: false,
    description: "Raw video uploads Qencode encodes from. Temporary.",
  },
] as const;

/** Longest prefix first, so `blog/imported` wins over a hypothetical `blog`. */
const CATEGORIES_BY_SPECIFICITY = [...MEDIA_CATEGORIES].sort((a, b) => b.prefix.length - a.prefix.length);

const BY_PREFIX = new Map(MEDIA_CATEGORIES.map((category) => [category.prefix, category]));

/** The category with this exact prefix, or null. */
export function mediaCategory(prefix: string): MediaCategory | null {
  return BY_PREFIX.get(prefix) ?? null;
}

/**
 * The category an existing R2 key belongs to, or null.
 *
 * Matches on the prefix alone, which is what makes it work across BOTH key
 * layouts: the legacy `contest-banners/images/<uuid>.jpg` and the current
 * `contest-banners/2026/08/<uuid>.jpg` are the same category. Anything that
 * keyed off the full `"contest-banners/images/"` string would have silently
 * stopped recognising every new upload the moment the layout changed — and the
 * symptom would have been a deleted banner staying cached for a year.
 */
export function categoryForKey(key: string): MediaCategory | null {
  for (const category of CATEGORIES_BY_SPECIFICITY) {
    if (key === category.prefix || key.startsWith(`${category.prefix}/`)) return category;
  }
  return null;
}

/** Cache policy for a key. Unknown keys get the conservative answer. */
export function cachePolicyForKey(key: string): CachePolicy {
  return categoryForKey(key)?.cache ?? "immutable";
}

/**
 * True when a key must keep being served from the Worker at its stored URL.
 *
 * Unknown keys are NOT proxy-only: an unrecognised prefix is far more likely to
 * be an old key from before this registry than a new object with a deletion
 * lifecycle, and forcing every one of those through a Worker invocation would be
 * a real cost for no correctness gain.
 */
export function isProxyOnlyKey(key: string): boolean {
  return categoryForKey(key)?.proxyOnly ?? false;
}

/**
 * Prefixes a normal end user may name as an upload destination.
 *
 * Derived, so adding a category with `writer: "admin"` cannot accidentally open
 * it to `POST /upload` — which is the mistake this list existed to prevent, and
 * which a hand-maintained second copy of it would eventually make.
 */
export const USER_UPLOAD_PREFIXES: readonly string[] = MEDIA_CATEGORIES.filter(
  (category) => category.writer === "user",
).map((category) => category.prefix);

export function isUserWritablePrefix(prefix: string): boolean {
  return mediaCategory(prefix)?.writer === "user";
}

/**
 * The exact mime types a prefix may receive.
 *
 * Unknown prefixes get images only — failing closed, so adding a category
 * without thinking about this cannot silently open a video path.
 *
 * `allowLegacyVideo` is supplied by `lib/mediaRouting.ts` from the live provider
 * setting; it is never read from config here, because "what may this prefix
 * contain" and "is Qencode switched on" are separate questions and mixing them is
 * how a storage rule ends up depending on an integration being reachable.
 */
export function allowedMimesForCategory(
  prefix: string,
  opts: { allowLegacyVideo?: boolean } = {},
): readonly MediaMime[] {
  const category = mediaCategory(prefix);
  if (!category) return IMAGE_MIME_TYPES;

  const kinds = new Set<MediaKind>(category.kinds);
  if (opts.allowLegacyVideo && category.legacyVideo) kinds.add("video");

  return ALLOWED_MEDIA_MIME_TYPES.filter((mime) => {
    const kind = kindOf(mime);
    return kind !== null && kinds.has(kind);
  });
}

/**
 * Whether a prefix could ever hold video, ignoring the current provider.
 *
 * Used only to pick the pre-read size cap: a request that will be rejected as
 * video anyway should be rejected on the small image cap, not buffered up to
 * 80 MB first.
 */
export function categoryEverAcceptedVideo(prefix: string): boolean {
  return mediaCategory(prefix)?.legacyVideo ?? false;
}

/** `2026/08` in UTC. */
function dateShard(at: Date): string {
  const month = String(at.getUTCMonth() + 1).padStart(2, "0");
  return `${at.getUTCFullYear()}/${month}`;
}

/**
 * Maximum path segments after the category prefix.
 *
 * `{YYYY}/{MM}/{file}` is three. This bound is a security property, not a
 * tidiness one: `ownedKeyFromPublicUrl` maps a client-supplied URL back to a key
 * and has to decide how much path it will accept after a prefix it trusts.
 */
export const MAX_KEY_SEGMENTS_AFTER_PREFIX = 3;

/** Single path segment of a key we minted: UUID or hex hash, plus an extension. */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Whether `rest` is a path this deployment could have produced under a prefix.
 *
 * Replaces an "is a single path segment" check that was correct for the old flat
 * layout and would have rejected every date-sharded key — silently breaking
 * contest-banner and battle-card deletion for all new uploads, with no error
 * anywhere, while the bucket kept growing.
 *
 * Still strictly closed: bounded depth, no empty segments, no `.` or `..`, and a
 * charset that excludes `/`, `%` and `\` so neither raw nor percent-encoded
 * traversal can survive. `URL.pathname` is not decoded, so `%2e%2e` arrives
 * literally and is rejected by the charset rather than needing a special case.
 */
export function isSafeRelativeKey(rest: string): boolean {
  if (!rest) return false;
  const segments = rest.split("/");
  if (segments.length > MAX_KEY_SEGMENTS_AFTER_PREFIX) return false;
  return segments.every((segment) => segment !== "." && segment !== ".." && SAFE_SEGMENT.test(segment));
}

/**
 * The key a new upload should be written to.
 *
 * `{prefix}/{YYYY}/{MM}/{uuid}{ext}` for date-sharded categories.
 *
 * The date shard is not cosmetic. R2 lifecycle rules, Cloudflare cache rules and
 * `wrangler r2 object list` are all prefix-based, so a flat prefix holding every
 * avatar ever uploaded is one you cannot expire, cache-rule or even enumerate
 * selectively. Sharding by month makes each of those a bounded operation, and
 * makes "what did we ingest in August" answerable without a full-bucket scan.
 *
 * It also removes the old `images|videos` segment, which existed to separate two
 * families that no longer share this bucket.
 */
export function buildMediaKey(prefix: string, extension: string, at: Date = new Date()): string {
  const category = mediaCategory(prefix);
  const id = crypto.randomUUID();
  if (category && !category.dateSharded) return `${prefix}/${id}${extension}`;
  return `${prefix}/${dateShard(at)}/${id}${extension}`;
}
