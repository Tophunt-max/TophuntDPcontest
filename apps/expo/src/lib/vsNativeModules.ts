/**
 * The single place the optional native modules behind the composite VS card are
 * resolved. Everything else imports from here and treats a `null` as normal.
 *
 * ---------------------------------------------------------------------------
 * Why this is its own file, with a `.web.ts` sibling
 * ---------------------------------------------------------------------------
 * `require()` inside a function looks lazy, but Metro collects dependency edges
 * *syntactically* — a require anywhere in a reachable module pulls the package
 * into the bundle regardless of whether it is ever called. `react-native-view-shot`
 * depends on `html2canvas` (4.5 MB unpacked) for its web implementation, so a
 * lazy require put the whole of html2canvas into the web bundle to support a
 * feature that is switched off on web. Confirmed by grepping `expo export -p web`
 * output for html2canvas internals.
 *
 * Splitting on platform is the only thing that actually removes it: `.web.ts` has
 * no reference to the package, so the web bundle has no edge to follow. It also
 * means the platform check lives in the module system rather than in an
 * `if (Platform.OS === 'web')` that every caller has to remember.
 *
 * ---------------------------------------------------------------------------
 * Why the requires are still guarded
 * ---------------------------------------------------------------------------
 * These are NATIVE modules. An install that has not been rebuilt since they were
 * added ships the JavaScript but not the native side, so resolution or first use
 * throws. Returning null lets the app degrade — the story renders its live layout
 * and sharing sends text — instead of crashing a screen users open constantly.
 */

export type ViewShotModule = {
  captureRef?: (ref: any, opts?: any) => Promise<string>;
  /**
   * Frees a `tmpfile` capture. Every capture writes a full-screen image into the
   * app's cache directory, so a background capture per battle plus one per share
   * tap accumulates without this.
   */
  releaseCapture?: (uri: string) => void;
};

export type SharingModule = {
  isAvailableAsync?: () => Promise<boolean>;
  shareAsync?: (url: string, opts?: any) => Promise<void>;
};

// `undefined` means "not tried yet", `null` means "tried and unavailable". A
// plain falsy check would retry a failing require on every story frame.
let viewShot: ViewShotModule | null | undefined;
let sharing: SharingModule | null | undefined;

/**
 * The capture API, or null where it cannot be loaded.
 *
 * Worth knowing why the try/catch is a precise test and not just defensiveness:
 * `react-native-view-shot` resolves its native side with
 * `TurboModuleRegistry.getEnforcing('RNViewShot')`, which THROWS at import time
 * when the module is not linked. So an install carrying the JavaScript but not the
 * native binary — every install that predates this feature — fails here rather
 * than succeeding and then failing later at capture time. That is what makes
 * `isVsCaptureSupported()` trustworthy enough to gate behaviour on.
 */
export function getViewShot(): ViewShotModule | null {
  if (viewShot === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      viewShot = require('react-native-view-shot');
    } catch {
      viewShot = null;
    }
  }
  return viewShot ?? null;
}

/** The share-sheet API that can attach a file, or null. */
export function getSharing(): SharingModule | null {
  if (sharing === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      sharing = require('expo-sharing');
    } catch {
      sharing = null;
    }
  }
  return sharing ?? null;
}
