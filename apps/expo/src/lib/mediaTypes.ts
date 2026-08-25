/**
 * Client mirror of the Worker's upload policy (apps/worker/src/lib/mediaTypes.ts).
 *
 * The server is the security boundary — nothing here is a control, because
 * anything running on the user's device can be bypassed. This exists so a user
 * who picks the wrong file gets an immediate, specific message instead of a
 * generic 400 after uploading 40 MB over mobile data, and so the app stops
 * sending a MIME type it merely guessed.
 *
 * Keep the lists and the caps in sync with the Worker. If they drift, the symptom
 * is a file the app accepts and the server rejects, which reads to the user as a
 * broken upload.
 */

export const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;
export const VIDEO_MIME_TYPES = ['video/mp4', 'video/quicktime'] as const;

export type MediaMime = (typeof IMAGE_MIME_TYPES)[number] | (typeof VIDEO_MIME_TYPES)[number];
export type MediaKind = 'image' | 'video';

/** Mirrors MAX_IMAGE_BYTES / MAX_VIDEO_BYTES in the Worker. */
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 80 * 1024 * 1024;

export function kindOf(mime: string): MediaKind | null {
  if ((IMAGE_MIME_TYPES as readonly string[]).includes(mime)) return 'image';
  if ((VIDEO_MIME_TYPES as readonly string[]).includes(mime)) return 'video';
  return null;
}

/** Bytes the sniffer needs: an ISO-BMFF brand sits at offset 8..12. */
export const SNIFF_BYTES = 16;

function ascii(bytes: Uint8Array, offset: number, expected: string): boolean {
  if (bytes.length < offset + expected.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if (bytes[offset + i] !== expected.charCodeAt(i)) return false;
  }
  return true;
}

const MP4_BRANDS = [
  'isom', 'iso2', 'iso4', 'iso5', 'iso6', 'iso8',
  'mp41', 'mp42', 'mp71',
  'avc1', 'dash', 'mmp4', 'M4V ', 'M4VH', 'M4VP', 'MSNV', 'NDSC', '3gp4', '3gp5',
] as const;

/**
 * Identify a file from its leading bytes. Same signature set as the Worker, so a
 * file this accepts is a file the server will accept.
 */
export function sniffMediaMime(bytes: Uint8Array): MediaMime | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return 'image/png';
  if (ascii(bytes, 0, 'GIF87a') || ascii(bytes, 0, 'GIF89a')) return 'image/gif';
  if (ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP')) return 'image/webp';
  if (ascii(bytes, 4, 'ftyp')) {
    if (ascii(bytes, 8, 'qt  ')) return 'video/quicktime';
    for (const brand of MP4_BRANDS) if (ascii(bytes, 8, brand)) return 'video/mp4';
    return null;
  }
  return null;
}

/** Message shown when a picked file is not a supported image or video at all. */
export const UNSUPPORTED_FILE_MESSAGE =
  'That file type is not supported. Please choose a JPG, PNG, WebP or GIF photo, or an MP4/MOV video.';

/** Message shown when the file is fine but belongs to the other family. */
export function wrongKindMessage(expected: MediaKind): string {
  return expected === 'image'
    ? 'That looks like a video. Please choose a photo.'
    : 'That looks like a photo. Please choose a video.';
}

export function tooLargeMessage(kind: MediaKind): string {
  const mb = Math.round((kind === 'video' ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES) / (1024 * 1024));
  return kind === 'video'
    ? `That video is too large (max ${mb}MB). Please trim it and try again.`
    : `That photo is too large (max ${mb}MB). Please choose a smaller one.`;
}
