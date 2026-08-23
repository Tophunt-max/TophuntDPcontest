import { ImageManipulator, SaveFormat, type ImageRef } from 'expo-image-manipulator';

/**
 * Downscale + recompress a picked image before uploading it.
 *
 * Why this exists: the app used to upload whatever the picker returned — a
 * modern phone camera photo is 3-8 MB at 4000x3000 — and `POST /upload` stores
 * it verbatim (the only guard is an 80 MB cap). Every feed, grid and story then
 * fetched those full-resolution bytes. Resizing here is by far the largest
 * loading win available: dropping 4000x3000 to 1080x1440 is a ~12x reduction in
 * pixels before compression even applies.
 *
 * This belongs on the client because the server-side alternative (Cloudflare
 * Transformations / Images) needs the media custom domain, which is not yet
 * provisioned. See MEDIA_MIGRATION_PLAN.md Phase 1c.
 *
 * Format is JPEG deliberately. Every one of these upload paths already declared
 * `image/jpeg` to the Worker, so this is not a behaviour change, and JPEG is
 * supported on every platform. WEBP would save a further ~25-30% and the Worker
 * already accepts `image/webp`, but it is not reliably supported across
 * platforms by this library, so it is left as a follow-up.
 *
 * Failure is never fatal: if manipulation throws for any reason the original URI
 * is returned and the upload proceeds as before.
 */

export type ImagePreset = 'avatar' | 'story' | 'contest' | 'deposit';

interface PresetConfig {
  /** Cap on the LONGEST edge, in px. Aspect ratio is always preserved. */
  maxEdge: number;
  /** 0..1, where 1 is no compression. */
  compress: number;
  reason: string;
}

const PRESETS: Record<ImagePreset, PresetConfig> = {
  // Rendered at 96px at most, but keep headroom for retina and the profile
  // header's larger circle.
  avatar: { maxEdge: 512, compress: 0.85, reason: 'displayed at <=96px' },
  // Instagram's own story spec is 1080x1920, which a 9:16 photo lands on exactly
  // when the longest edge is capped at 1920.
  story: { maxEdge: 1920, compress: 0.8, reason: 'full-screen 1080x1920' },
  // Contest entries are judged by voters, so keep a little more detail.
  contest: { maxEdge: 1440, compress: 0.85, reason: 'judged by voters' },
  // A UPI payment screenshot an admin has to read — text must stay legible, so
  // this is the most conservative preset.
  deposit: { maxEdge: 1600, compress: 0.9, reason: 'admin must read the text' },
};

/** Release a native image ref without letting cleanup failures surface. */
function release(ref: ImageRef | null): void {
  try {
    ref?.release();
  } catch {
    /* already released by the runtime */
  }
}

/**
 * Returns a URI to an optimized copy, or the original URI if optimization was
 * not possible or not worth doing.
 *
 * Only ever call this for images — video must go straight to its own path.
 */
export async function optimizeImageForUpload(
  uri: string,
  preset: ImagePreset,
): Promise<string> {
  const { maxEdge, compress } = PRESETS[preset];

  let probe: ImageRef | null = null;
  let resized: ImageRef | null = null;

  try {
    // Decode once to learn the real dimensions. `manipulate` also accepts an
    // ImageRef, so the decoded bitmap is reused below instead of being read from
    // disk a second time.
    probe = await ImageManipulator.manipulate(uri).renderAsync();

    const longest = Math.max(probe.width, probe.height);

    // Already small enough — recompress only. Never upscale: that would add
    // bytes and invent detail.
    if (longest <= maxEdge) {
      const out = await probe.saveAsync({ format: SaveFormat.JPEG, compress });
      return out.uri;
    }

    // Constrain the longer edge and let the library derive the other one, so the
    // aspect ratio is preserved for both portrait and landscape sources.
    const size =
      probe.width >= probe.height ? { width: maxEdge } : { height: maxEdge };

    resized = await ImageManipulator.manipulate(probe).resize(size).renderAsync();
    const out = await resized.saveAsync({ format: SaveFormat.JPEG, compress });
    return out.uri;
  } catch (e) {
    // A failed optimization must not block the user's upload.
    console.warn(`[imageOptimize] ${preset} optimization failed, uploading original:`, e);
    return uri;
  } finally {
    release(resized);
    release(probe);
  }
}
