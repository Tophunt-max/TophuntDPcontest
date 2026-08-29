/**
 * Uploads must be decided by the file's bytes, not by what the uploader claims.
 *
 * Every upload path used to authorise on a declared MIME type — a query param on
 * `/upload`, a header on the admin routes. That string comes from the uploader,
 * so `?fileType=image/png` with a ZIP body was stored as
 * `avatars/images/<uuid>.png` with `Content-Type: image/png` and a one-year
 * immutable cache header, served from our own origin and billed to us.
 *
 * These tests pin the two halves of the fix that are easy to regress:
 *
 *  - the sniffer says no to the things that look like images only by name, and
 *  - `uploadToR2` stores what it DETECTED, so no future route can reintroduce the
 *    bug by forgetting to validate before calling it.
 *
 * The negative cases are the point. A test that only proves a real JPEG is
 * accepted would have passed against the vulnerable code too.
 */
import { describe, it, expect } from 'vitest';
import {
  IMAGE_MIME_TYPES,
  VIDEO_MIME_TYPES,
  REJECTED_IMAGE_MIME_TYPES,
  MAX_IMAGE_BYTES,
  MAX_VIDEO_BYTES,
  extensionForMime,
  kindOf,
  sniffMediaMime,
  verifyMediaBytes,
} from '../src/lib/mediaTypes';
import {
  uploadToR2,
  putVerifiedImage,
  allowedMimesForFolder,
  folderAcceptsVideo,
  USER_UPLOAD_FOLDERS,
} from '../src/lib/r2';
import { allowedMimesForCategory, isUserWritablePrefix } from '../src/lib/mediaCategories';
import { fakeR2 } from './helpers/harness';

const bytes = (...values: number[]) => new Uint8Array(values);
const withAscii = (prefix: number[], text: string, pad = 0) =>
  new Uint8Array([...prefix, ...[...text].map((ch) => ch.charCodeAt(0)), ...new Array(pad).fill(0)]);

/** Minimal but genuine file headers. */
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d);
const GIF = withAscii([], 'GIF89a', 6);
const WEBP = withAscii([], 'RIFF\u0000\u0000\u0000\u0000WEBPVP8 ');
// An ISO-BMFF header: 4-byte box size, then `ftyp`, then the brand.
const MP4 = withAscii([0x00, 0x00, 0x00, 0x18], 'ftypisom', 4);
const MOV = withAscii([0x00, 0x00, 0x00, 0x14], 'ftypqt  ', 4);

describe('sniffMediaMime', () => {
  it.each([
    ['JPEG', JPEG, 'image/jpeg'],
    ['PNG', PNG, 'image/png'],
    ['GIF', GIF, 'image/gif'],
    ['WebP', WEBP, 'image/webp'],
    ['MP4', MP4, 'video/mp4'],
    ['MOV', MOV, 'video/quicktime'],
  ])('identifies a real %s', (_label, input, expected) => {
    expect(sniffMediaMime(input)).toBe(expected);
  });

  /**
   * Each of these was storable as an "image" before. They are grouped here
   * because the shared property — a recognisable header that is not ours — is
   * exactly what the declared-type check could not see.
   */
  it.each([
    ['an SVG (scriptable XML, the stored-XSS case)', '<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'],
    ['an SVG behind an XML declaration', '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>'],
    ['an HTML page', '<!DOCTYPE html><html><body><script>alert(1)</script>'],
    ['a PDF', '%PDF-1.7\n%\xe2\xe3\xcf\xd3'],
    ['plain text', 'this is just a text file, not a photo'],
    ['an empty file', ''],
  ])('refuses %s', (_label, text) => {
    expect(sniffMediaMime(new TextEncoder().encode(text))).toBeNull();
  });

  it('refuses a ZIP, which is also every APK and DOCX', () => {
    // "PK\x03\x04" — the single most likely thing someone tries to park on a CDN.
    expect(sniffMediaMime(withAscii([], 'PK\u0003\u0004', 12))).toBeNull();
  });

  it('refuses native executables', () => {
    expect(sniffMediaMime(bytes(0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00))).toBeNull(); // ELF
    expect(sniffMediaMime(withAscii([], 'MZ', 14))).toBeNull(); // PE/EXE
  });

  it('refuses a RIFF container that is not WebP', () => {
    // WAV and AVI share the RIFF prefix, so checking only "RIFF" would let an
    // audio file be stored as image/webp.
    expect(sniffMediaMime(withAscii([], 'RIFF\u0000\u0000\u0000\u0000WAVEfmt '))).toBeNull();
  });

  it('refuses an ftyp box with a brand we cannot play', () => {
    // Storing this would put an unplayable file behind a .mp4 URL.
    expect(sniffMediaMime(withAscii([0, 0, 0, 0x18], 'ftypcrx ', 4))).toBeNull();
  });

  it('refuses a truncated header rather than guessing', () => {
    expect(sniffMediaMime(bytes(0xff, 0xd8))).toBeNull(); // JPEG SOI, third byte missing
    expect(sniffMediaMime(bytes(0x89, 0x50, 0x4e, 0x47))).toBeNull(); // half a PNG signature
  });

  it('is not fooled by an image signature that appears later in the file', () => {
    // A polyglot/appended-payload file: the real header decides, not a match
    // anywhere in the body.
    const decoy = new Uint8Array([...new TextEncoder().encode('<html>'), ...JPEG]);
    expect(sniffMediaMime(decoy)).toBeNull();
  });
});

describe('verifyMediaBytes', () => {
  it('returns the detected type, ignoring a lying declaration', () => {
    expect(verifyMediaBytes(PNG, 'image/jpeg', IMAGE_MIME_TYPES)).toBe('image/png');
  });

  it('accepts a .mov declared as mp4, because the app does exactly that', () => {
    // apps/expo/src/services/contests/uploadMedia.ts hard-coded video/mp4 for any
    // picked video. Demanding an exact match would reject every iOS entry from
    // builds already in the wild, so family agreement is what is enforced.
    expect(verifyMediaBytes(MOV, 'video/mp4', VIDEO_MIME_TYPES)).toBe('video/quicktime');
  });

  it('refuses a video body where an image is expected', () => {
    expect(() => verifyMediaBytes(MP4, 'image/jpeg', IMAGE_MIME_TYPES)).toThrow(/not allowed here/i);
  });

  it('refuses an image body where a video is expected', () => {
    expect(() => verifyMediaBytes(JPEG, 'video/mp4', VIDEO_MIME_TYPES)).toThrow(/not allowed here/i);
  });

  it('enforces an exact match when given a single-entry allow-list', () => {
    // How the admin banner routes stay strict: the panel sends the browser's own
    // file.type, so the bytes must match it exactly.
    expect(() => verifyMediaBytes(PNG, 'image/jpeg', ['image/jpeg'])).toThrow(/not allowed here/i);
    expect(verifyMediaBytes(PNG, 'image/png', ['image/png'])).toBe('image/png');
  });

  it('explains itself when the file is not media at all', () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
    expect(() => verifyMediaBytes(svg, 'image/png', IMAGE_MIME_TYPES)).toThrow(
      /not a supported image or video/i,
    );
  });
});

describe('folder policy', () => {
  it('keeps SVG out of the accepted image list, permanently', () => {
    for (const rejected of REJECTED_IMAGE_MIME_TYPES) {
      expect(IMAGE_MIME_TYPES as readonly string[]).not.toContain(rejected);
      // And nothing can route to it, because the sniffer has no SVG branch.
      expect(allowedMimesForFolder('avatars')).not.toContain(rejected as any);
    }
  });

  /**
   * R2 holds images. Every prefix, including the five that used to take video.
   *
   * This is the storage rule, asked without reference to the video provider —
   * which is why it is `allowedMimesForFolder` and not `allowedMimesForUpload`.
   */
  it.each([...USER_UPLOAD_FOLDERS])('%s accepts images only', (folder) => {
    expect(allowedMimesForFolder(folder)).toEqual([...IMAGE_MIME_TYPES]);
    for (const video of VIDEO_MIME_TYPES) {
      expect(allowedMimesForFolder(folder)).not.toContain(video);
    }
  });

  /**
   * The legacy video escape hatch, which is what keeps the cutover from being an
   * outage: until Bunny is provisioned, `lib/mediaRouting.ts` passes
   * `allowLegacyVideo` and the five prefixes the app actually offered video in
   * accept it again. Pinned because deleting this branch is a planned follow-up,
   * and it must be deleted deliberately rather than by a refactor.
   */
  it.each(['stories', 'contests', 'contest-entries', 'posts', 'chat'])(
    '%s takes video back only when the legacy path is explicitly allowed',
    (folder) => {
      expect(folderAcceptsVideo(folder)).toBe(true);
      expect(allowedMimesForCategory(folder, { allowLegacyVideo: true })).toContain('video/mp4');
    },
  );

  it.each(['avatars', 'deposits', 'vs-cards', 'profile', 'reports', 'misc'])(
    '%s refuses video even with the legacy path allowed',
    (folder) => {
      // An avatar was never allowed to be a video and must not become one just
      // because the cutover is unfinished. `deposits` matters beyond tidiness: an
      // admin reads a UPI reference off those, and a clip in that queue wastes an
      // operator's time and our egress.
      expect(folderAcceptsVideo(folder)).toBe(false);
      expect(allowedMimesForCategory(folder, { allowLegacyVideo: true })).toEqual([...IMAGE_MIME_TYPES]);
    },
  );

  it('fails closed for a folder nobody classified', () => {
    // Adding a category without thinking about this must not open a video path,
    // even with the legacy allowance switched on.
    expect(folderAcceptsVideo('some-folder-added-later')).toBe(false);
    expect(allowedMimesForFolder('some-folder-added-later')).toEqual([...IMAGE_MIME_TYPES]);
    expect(allowedMimesForCategory('some-folder-added-later', { allowLegacyVideo: true })).toEqual([
      ...IMAGE_MIME_TYPES,
    ]);
  });

  it('never exposes a deployment-owned prefix to POST /upload', () => {
    // The allow-list is derived from each category's `writer`, so an admin- or
    // server-written prefix cannot appear here by omission.
    for (const prefix of ['contest-banners', 'payment-qr', 'blog/imported']) {
      expect(USER_UPLOAD_FOLDERS as readonly string[]).not.toContain(prefix);
      expect(isUserWritablePrefix(prefix)).toBe(false);
    }
  });

  it('classifies every folder a user can write to', () => {
    // A missing entry is safe but probably unintended — this is the nudge.
    for (const folder of USER_UPLOAD_FOLDERS) {
      expect(allowedMimesForFolder(folder).length).toBeGreaterThan(0);
    }
  });

  it('caps images far below videos', () => {
    // One 80MB cap for both meant an 80MB "avatar" was legal.
    expect(MAX_IMAGE_BYTES).toBeLessThan(MAX_VIDEO_BYTES);
  });
});

describe('uploadToR2', () => {
  const env = () => ({ MEDIA: fakeR2(), R2_PUBLIC_BASE_URL: 'https://cdn.test' }) as any;

  it('stores the detected content type, not the declared one', async () => {
    const e = env();
    const { fileKey, contentType } = await uploadToR2(e, 'image/jpeg', 'avatars', PNG);

    expect(contentType).toBe('image/png');
    expect(e.MEDIA._objects.get(fileKey).httpMetadata.contentType).toBe('image/png');
    // The extension follows the bytes too, so a URL never misrepresents its content.
    expect(fileKey).toMatch(/^avatars\/\d{4}\/\d{2}\/[0-9a-f-]+\.png$/);
  });

  /**
   * Keys carry a `{YYYY}/{MM}` shard, and no `images|videos` segment.
   *
   * The shard is what makes R2 lifecycle rules, Cloudflare cache rules and
   * `wrangler r2 object list` bounded operations instead of full-prefix scans —
   * see lib/mediaCategories.ts. The dropped segment separated two families that
   * no longer share this bucket.
   */
  it('shards new keys by month', async () => {
    const e = env();
    const { fileKey } = await uploadToR2(e, 'image/jpeg', 'stories', JPEG);

    expect(fileKey).toMatch(/^stories\/\d{4}\/\d{2}\/[0-9a-f-]+\.jpg$/);
    expect(fileKey).not.toContain('/images/');
  });

  /** Content-hash keys stay flat, or the deduplication they exist for stops working. */
  it('does not shard the content-hash importer prefix', async () => {
    const e = env();
    const first = await putVerifiedImage(e, 'blog/imported', PNG.buffer as ArrayBuffer, 'abc123');
    const second = await putVerifiedImage(e, 'blog/imported', PNG.buffer as ArrayBuffer, 'abc123');

    expect(first?.key).toBe('blog/imported/abc123.png');
    expect(second?.key).toBe(first?.key);
    expect(second?.cached).toBe(true);
    expect(e.MEDIA._objects.size).toBe(1);
  });

  it('refuses video by default, in every folder', async () => {
    // R2 is images-only: the default allow-list carries no video type, so a video
    // is rejected on the allow-list even in a folder that used to take one. The
    // routing gate in `POST /upload` produces the actionable message; this is the
    // backstop at the choke point in front of the bucket.
    const e = env();
    for (const folder of ['stories', 'contests', 'posts', 'chat', 'avatars']) {
      await expect(uploadToR2(e, 'video/mp4', folder, MP4)).rejects.toThrow(/not allowed here/i);
      await expect(uploadToR2(e, 'video/mp4', folder, MOV)).rejects.toThrow(/not allowed here/i);
    }
    expect(e.MEDIA._objects.size).toBe(0);
  });

  it('refuses a family mismatch when the legacy video path is open', async () => {
    // During cutover `stories` accepts images AND videos, so the allow-list alone
    // cannot catch a video offered as an image — the declared-vs-detected family
    // check is what does. Passing the legacy list explicitly is what recreates
    // that window now that it is not the default.
    const e = env();
    const legacy = allowedMimesForCategory('stories', { allowLegacyVideo: true });

    await expect(uploadToR2(e, 'image/jpeg', 'stories', MP4, legacy)).rejects.toThrow(
      /is a video, but an image was expected/i,
    );
    expect(e.MEDIA._objects.size).toBe(0);
  });

  it('writes nothing when the bytes are not media', async () => {
    const e = env();
    const zip = withAscii([], 'PK\u0003\u0004', 12);

    await expect(uploadToR2(e, 'image/png', 'avatars', zip)).rejects.toThrow(
      /not a supported image or video/i,
    );
    // The object must not exist: a rejected upload that still wrote would leave
    // us hosting the file anyway.
    expect(e.MEDIA._objects.size).toBe(0);
  });

  it('refuses a video for an image-only destination', async () => {
    const e = env();
    await expect(
      uploadToR2(e, 'video/mp4', 'avatars', MP4, allowedMimesForFolder('avatars')),
    ).rejects.toThrow(/not allowed here/i);
    expect(e.MEDIA._objects.size).toBe(0);
  });
});

describe('extensionForMime', () => {
  it.each([
    ['image/jpeg', '.jpg'],
    ['image/png', '.png'],
    ['image/gif', '.gif'],
    ['image/webp', '.webp'],
    ['video/mp4', '.mp4'],
    ['video/quicktime', '.mov'],
  ])('maps %s to %s', (mime, ext) => {
    expect(extensionForMime(mime)).toBe(ext);
  });

  it('gives nothing for a type we do not store', () => {
    // No `.img` fallback: the importer used to invent one, which produced keys
    // whose extension told a reader nothing about the content.
    expect(extensionForMime('image/svg+xml')).toBe('');
    expect(extensionForMime('application/zip')).toBe('');
    expect(kindOf('image/svg+xml')).toBeNull();
  });
});
