import { getViewShot } from '@/src/lib/vsNativeModules';

/**
 * Turning a battle's head-to-head frame into one real image file.
 *
 * The battle's canonical VS card is rendered by the SERVER from the two accepted
 * entries (Worker `lib/vsPublication.ts`) and is what both participants' Stories
 * and every share path use (`src/lib/vsShareAsset.ts`). This module only captures
 * the on-screen frame, as the gated FALLBACK for when that image cannot be
 * obtained. Sharing itself lives in `src/lib/share.ts#shareImageFile`.
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
 * Capture a designed share card (e.g. the 9:16 winner card) at an exact output
 * size. Same engine as `captureVsCard`: react-native-view-shot on Android/iOS,
 * html-to-image on web (vsNativeModules.web.ts), so web gets a real screenshot
 * too. Returns a `file://` (native) or `blob:` (web) uri, or null on any failure.
 */
export async function captureShareCard(
  ref: any,
  opts: { width: number; height: number; quality?: number; backgroundColor?: string },
): Promise<string | null> {
  const mod = getViewShot();
  if (!ref || typeof mod?.captureRef !== 'function') return null;
  // iOS view-shot treats width/height as POINTS and renders at screen scale, so
  // 1080 would come out 3240px wide on a @3x phone (a ~75MB bitmap, and the
  // "blank capture" failure mode the library warns about for large views).
  // Android and web take pixels.
  // Required lazily: this module is also imported by Node tests that do not load
  // react-native at all.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PixelRatio, Platform } = require('react-native');
  const scale = Platform.OS === 'ios' ? PixelRatio.get() || 1 : 1;
  try {
    return await mod.captureRef(ref, {
      format: 'jpg',
      quality: opts.quality ?? 0.92,
      result: 'tmpfile',
      width: opts.width / scale,
      height: opts.height / scale,
      backgroundColor: opts.backgroundColor,
    });
  } catch (e) {
    console.warn('[vsImage] share card capture failed', e);
    return null;
  }
}
