import { callApi } from '@/src/services/api';
import { uploadToR2 } from '@/src/lib/uploadToR2';
import { getSharing, getViewShot } from '@/src/lib/vsNativeModules';

/**
 * Turning a battle's head-to-head frame into one real image file.
 *
 * The frame itself is laid out in React (`components/stories/StoryVsFrame.tsx`)
 * because the Worker cannot compose images — see `migrations/0033_match_vs_image.sql`
 * for that reasoning. But a layout is not something you can hand to WhatsApp or
 * Instagram, which want a single file. So the rendered view is captured to an image.
 *
 * The capture happens on the view that is ALREADY on screen in the story viewer,
 * deliberately. An off-screen host would have to prefetch both remote images and
 * then guess when they had decoded, because `captureRef` only captures painted
 * pixels — an undecoded image yields a blank card. If the user is looking at the
 * frame, it is painted by definition.
 *
 * ---------------------------------------------------------------------------
 * Everything here is optional at runtime
 * ---------------------------------------------------------------------------
 * The capture and share-sheet modules are NATIVE, and legitimately absent on web
 * and on any install that has not been rebuilt since they were added
 * (`vsNativeModules.ts` owns that resolution). So every entry point below reports
 * failure instead of throwing: the story keeps rendering the live layout, sharing
 * falls back to text, and the feature simply switches on after the next native
 * build.
 */

/** MIME type of a captured card. Kept next to the capture options that produce it. */
const CARD_MIME = 'image/jpeg';

/**
 * A uri the share sheet can actually attach: a local capture, not a remote link.
 *
 * The capture is `file://` on native (view-shot tmpfile) and `blob:` on web
 * (html-to-image object URL); both are the local, freshly-produced image. A
 * remote `https://` url — e.g. an already-recorded card read back from the API —
 * is deliberately excluded: a share sheet cannot attach a URL as a file, and
 * trying would either fail or, worse, share a bare link where the caller's own
 * text fallback does that job better.
 */
function isLocalCaptureUri(uri: string | null | undefined): uri is string {
  return typeof uri === 'string' && (uri.startsWith('file://') || uri.startsWith('blob:'));
}

/**
 * Whether a capture can be attempted at all.
 *
 * False on web, and false on any build whose native side predates the module —
 * precisely, because the module throws at import when it is not linked (see
 * `vsNativeModules.ts`). Callers use this to skip work that would certainly fail,
 * not to decide whether to handle failure, which they must do regardless.
 */
export function isVsCaptureSupported(): boolean {
  return typeof getViewShot()?.captureRef === 'function';
}

/**
 * Free a captured temp file.
 *
 * `result: 'tmpfile'` writes a full-screen image into the app's cache directory
 * every time, so without this a background capture per battle plus one per share
 * tap accumulates for the life of the install. Safe to call with anything.
 */
export function releaseVsCard(localUri: string | null | undefined): void {
  if (!localUri) return;
  try {
    getViewShot()?.releaseCapture?.(localUri);
  } catch (e) {
    console.warn('[vsImage] releasing a capture failed', e);
  }
}

/** Capture a mounted view to a local image file. Returns null on any failure. */
export async function captureVsCard(ref: any): Promise<string | null> {
  const mod = getViewShot();
  if (!ref || typeof mod?.captureRef !== 'function') return null;
  try {
    // JPEG, not PNG. The captured view is a full-screen story frame, so a
    // lossless capture is several megabytes — which this then uploads over
    // whatever connection the user is on, and serves back to two viewers. The
    // frame is photographs on a gradient with no transparency, which is exactly
    // what JPEG is good at, so 0.92 is visually indistinguishable at a fraction
    // of the size.
    //
    // `result: 'tmpfile'` gives a file:// uri, which is what both the uploader
    // (`fetch(uri).blob()`) and the share sheet want. A base64 string would mean
    // holding the whole image in JS memory twice.
    return await mod.captureRef(ref, { format: 'jpg', quality: 0.92, result: 'tmpfile' });
  } catch (e) {
    console.warn('[vsImage] capture failed', e);
    return null;
  }
}

/**
 * Upload a captured card and record it against the battle.
 *
 * Best-effort and silent: this runs in the background off a story view, and there
 * is nothing useful to tell the user if it fails — the frame they are looking at is
 * already correct.
 *
 * Returns the url the card should be known by. That is the SERVER's answer, not
 * necessarily the one just uploaded: the server keeps the first card recorded for
 * a battle, so a client that lost the race is told about the winner instead (and
 * its own upload is deleted server-side).
 */
export async function uploadAndRecordVsCard(localUri: string, matchId: string): Promise<string | null> {
  try {
    // `vs-cards` is its own upload prefix so the Worker can verify a recorded url
    // really is one of these before pointing anyone's story at it.
    const publicUrl = await uploadToR2(localUri, CARD_MIME, 'vs-cards');
    if (!publicUrl) return null;
    // The Worker checks the caller is a participant and that the url is ours, and
    // keeps the first card if one already exists.
    const res: any = await callApi('setMatchVsImage', { matchId, imageUrl: publicUrl });
    return res?.vsImageUrl || publicUrl;
  } catch (e) {
    console.warn('[vsImage] upload/record failed', e);
    return null;
  }
}

/**
 * Share a battle as one image, falling back to text when that is not possible.
 *
 * The fallback matters: sharing is the whole point of generating the image, so it
 * must still do *something* on web, on a pre-rebuild install, or when the capture
 * fails. `fallbackShare` is the caller's existing text-and-link share.
 */
export async function shareVsCard(opts: {
  /**
   * A local capture uri from `captureVsCard` — `file://` on native, `blob:` on
   * web. Remote (`https://`) urls cannot be attached as a file and are ignored.
   */
  imageUri?: string | null;
  fallbackShare: () => Promise<void> | void;
}): Promise<void> {
  const { imageUri, fallbackShare } = opts;
  const mod = getSharing();

  if (isLocalCaptureUri(imageUri) && typeof mod?.shareAsync === 'function') {
    try {
      const available = typeof mod.isAvailableAsync === 'function' ? await mod.isAvailableAsync() : true;
      if (available) {
        await mod.shareAsync(imageUri, {
          mimeType: CARD_MIME,
          dialogTitle: 'Share this battle',
          UTI: 'public.jpeg',
        });
        return;
      }
    } catch (e) {
      console.warn('[vsImage] share sheet failed, falling back to text', e);
    }
  }

  await fallbackShare();
}
