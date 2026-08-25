/**
 * What our bucket is allowed to contain, decided by BYTES rather than by what a
 * caller claims.
 *
 * Every upload path used to authorise on the declared MIME type alone — a query
 * param on `/upload`, a `Content-Type` header on the admin routes. That string is
 * chosen by the uploader, so it authorises nothing. `?fileType=image/png` with a
 * ZIP, an APK or an HTML page as the body was stored happily, and because the
 * stored `Content-Type` AND the key extension were both derived from the same
 * unverified string, the result was a `.png` served from our own origin with
 * `Content-Type: image/png` and `Cache-Control: immutable` for a year.
 *
 * Two concrete problems that made worth fixing properly:
 *
 *  1. Free file hosting on our domain, paid for by us. Any signed-in account
 *     could park arbitrary binaries behind a URL that looks like an image, and
 *     R2 storage + egress is billed to us. Rate limits bound the rate, not the
 *     nature of the content.
 *  2. Stored HTML/SVG is one config change away from being live script. Today
 *     `/media/*` is served BY the Worker, whose middleware sets `nosniff` and a
 *     `default-src 'none'` CSP, so a disguised HTML file is inert. But
 *     MEDIA_MIGRATION_PLAN.md requires moving `R2_PUBLIC_BASE_URL` to a media
 *     custom domain to enable Cloudflare Transformations, and a public R2 domain
 *     serves objects with NONE of that middleware. At that moment every
 *     `image/svg+xml` already sitting in the bucket becomes same-origin script on
 *     the media host. Rejecting it at the door is the only fix that survives that
 *     migration; the headers are a mitigation with an expiry date.
 *
 * So: this module is the single source of truth, and `sniffMediaMime` is the only
 * thing allowed to decide what a file is. The declared type is downgraded to a
 * hint we cross-check for consistency.
 */
import { httpsError } from "./http";

/** Raster images we accept. Deliberately no SVG — see the note below. */
export const IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;

/**
 * Video containers we accept. `video/quicktime` is here because iOS hands the
 * picker a `.mov` and re-encoding on-device is not worth it.
 */
export const VIDEO_MIME_TYPES = ["video/mp4", "video/quicktime"] as const;

/**
 * SVG is NOT an image for our purposes and must never be added to
 * `IMAGE_MIME_TYPES`.
 *
 * It is an XML document that can carry `<script>`, `<foreignObject>` and
 * external references. Served from a media host with no CSP it is a stored-XSS
 * primitive against that origin, and it cannot be validated by sniffing because
 * there is no fixed signature — any well-formed XML is a candidate. There is no
 * user-facing feature that needs it: avatars, entries, stories and deposit
 * screenshots are all photographs.
 */
export const REJECTED_IMAGE_MIME_TYPES = ["image/svg+xml", "image/svg"] as const;

export type ImageMime = (typeof IMAGE_MIME_TYPES)[number];
export type VideoMime = (typeof VIDEO_MIME_TYPES)[number];
export type MediaMime = ImageMime | VideoMime;
export type MediaKind = "image" | "video";

/** Everything `/upload` may accept, in either family. */
export const ALLOWED_MEDIA_MIME_TYPES: readonly MediaMime[] = [...IMAGE_MIME_TYPES, ...VIDEO_MIME_TYPES];

/**
 * Per-family byte caps.
 *
 * There used to be one 80 MB cap covering both, which meant an "avatar" could be
 * 80 MB. Images are downscaled on the client to at most 1920px JPEG (see
 * apps/expo/src/lib/imageOptimize.ts) and land well under 1 MB; 12 MB leaves room
 * for an un-optimised original from a high-end camera, because that helper fails
 * open by design and returns the source file when manipulation throws.
 */
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
/** Contest videos are capped at 30s on the client. */
export const MAX_VIDEO_BYTES = 80 * 1024 * 1024;

export function maxBytesForKind(kind: MediaKind): number {
  return kind === "video" ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
}

export function isImageMime(mime: string): mime is ImageMime {
  return (IMAGE_MIME_TYPES as readonly string[]).includes(mime);
}

export function isVideoMime(mime: string): mime is VideoMime {
  return (VIDEO_MIME_TYPES as readonly string[]).includes(mime);
}

/** `null` for anything we do not accept, so callers cannot forget the third case. */
export function kindOf(mime: string): MediaKind | null {
  if (isImageMime(mime)) return "image";
  if (isVideoMime(mime)) return "video";
  return null;
}

/**
 * Canonical extension for a VERIFIED mime.
 *
 * Never call this with a client-supplied string: the extension ends up in the
 * public URL, and a mismatch between extension and content is how a download
 * gets mis-handled downstream.
 */
export function extensionForMime(mime: string): string {
  switch (mime) {
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

/** Number of leading bytes `sniffMediaMime` needs. ISO-BMFF brands sit at 8..12. */
export const SNIFF_BYTES = 16;

/** ASCII compare against a byte range, so brand checks read like the spec. */
function ascii(bytes: Uint8Array, offset: number, expected: string): boolean {
  if (bytes.length < offset + expected.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if (bytes[offset + i] !== expected.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * ISO base-media-file-format brands that mean "MP4 we can play".
 *
 * An MP4 and a MOV are the same container with a different brand in the `ftyp`
 * box, which is exactly why the declared type cannot be trusted to tell them
 * apart — the client used to hard-code `video/mp4` for both.
 */
const MP4_BRANDS = [
  "isom", "iso2", "iso4", "iso5", "iso6", "iso8",
  "mp41", "mp42", "mp71",
  "avc1", "dash", "mmp4", "M4V ", "M4VH", "M4VP", "MSNV", "NDSC", "3gp4", "3gp5",
] as const;

/**
 * Identify a file from its magic bytes, or return `null`.
 *
 * `null` is the answer for SVG, HTML, PDF, ZIP/APK, ELF/EXE, plain text and a
 * truncated file — i.e. everything that is not one of the six containers above.
 * This is intentionally a small, boring signature check rather than a full
 * decode: a decoder is a much larger attack surface running on our bytes, and
 * the signature is enough to establish "this is a real JPEG/PNG/WebP/GIF/MP4/MOV
 * and not a renamed archive".
 *
 * What it does NOT prove: that the rest of the file is well-formed, or that a
 * valid image has safe EXIF. Those are not the risks being addressed here.
 */
export function sniffMediaMime(input: ArrayBuffer | Uint8Array): MediaMime | null {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);

  // JPEG: SOI marker followed by any marker start.
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }

  // PNG: the full 8-byte signature, including the CRLF/EOF trap bytes.
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return "image/png";
  }

  // GIF: both legal versions.
  if (ascii(bytes, 0, "GIF87a") || ascii(bytes, 0, "GIF89a")) {
    return "image/gif";
  }

  // WebP: a RIFF container whose form type is WEBP. Checking only "RIFF" would
  // also match WAV and AVI.
  if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WEBP")) {
    return "image/webp";
  }

  // MP4 / MOV: an `ftyp` box at offset 4, brand at offset 8.
  if (ascii(bytes, 4, "ftyp")) {
    if (ascii(bytes, 8, "qt  ")) return "video/quicktime";
    for (const brand of MP4_BRANDS) {
      if (ascii(bytes, 8, brand)) return "video/mp4";
    }
    // An ftyp box with a brand we do not recognise. Refuse rather than guess:
    // storing it would put an unplayable file behind a .mp4 URL.
    return null;
  }

  return null;
}

/**
 * Verify a body against a declared type and an allow-list, and return the type
 * we should actually store.
 *
 * The returned value — not the caller's string — is what must be written to R2
 * as `Content-Type` and used to build the key extension.
 *
 * `declared` is treated as a hint and only checked for FAMILY agreement, not for
 * an exact match. That is deliberate: the app hard-coded `video/mp4` for iOS
 * `.mov` pickups, so demanding an exact match would reject legitimate videos
 * from every existing build in the wild. Family agreement still catches the case
 * that matters — a video body offered to an image-only destination, or vice
 * versa. Callers that genuinely need an exact match (the admin banner routes,
 * where the panel sends the browser's own `file.type`) pass a single-entry
 * `allowed` list, which enforces it.
 */
export function verifyMediaBytes(
  body: ArrayBuffer | Uint8Array,
  declared: string,
  allowed: readonly string[],
): MediaMime {
  const detected = sniffMediaMime(body);
  if (!detected) {
    throw httpsError(
      "invalid-argument",
      "That file is not a supported image or video. Please upload a JPG, PNG, WebP or GIF image, or an MP4/MOV video.",
    );
  }
  if (!allowed.includes(detected)) {
    throw httpsError("invalid-argument", `${describe(detected)} files are not allowed here.`);
  }
  const declaredKind = kindOf(declared.split(";")[0].trim().toLowerCase());
  const detectedKind = kindOf(detected);
  if (declaredKind && declaredKind !== detectedKind) {
    throw httpsError(
      "invalid-argument",
      declaredKind === "image"
        ? "That file is a video, but an image was expected."
        : "That file is an image, but a video was expected.",
    );
  }
  return detected;
}

/** Human-readable name for an error message ("JPEG", "MOV"). */
export function describe(mime: string): string {
  const ext = extensionForMime(mime).replace(".", "").toUpperCase();
  return ext || mime;
}
