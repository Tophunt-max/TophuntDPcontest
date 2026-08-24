/**
 * Web build of the VS-card native module seam: there is nothing to load.
 *
 * This file exists to keep `react-native-view-shot` — and through it the 4.5 MB
 * `html2canvas` — out of the web bundle entirely. Metro collects `require()` edges
 * statically, so the native file's guarded, lazy require was still enough to drag
 * the whole dependency in to support a feature that does not run on web. See
 * `vsNativeModules.ts` for the full reasoning.
 *
 * Returning null is not a degraded path here, it is the correct one: the web build
 * shares text and renders the battle frame live, which is what it did before the
 * composite card existed.
 */

// `import type` / `export type`, never a plain import — these two lines are what
// the whole exclusion rests on. Drop a `type` keyword and Metro follows the edge
// back into the native file and pulls html2canvas into the web bundle again.
import type { ViewShotModule, SharingModule } from './vsNativeModules';

export type { ViewShotModule, SharingModule } from './vsNativeModules';

// Return types are the FULL union, not `null`, so that a caller type-checked
// against this file sees the same contract as one type-checked against the native
// file. (`tsc` resolves the native one, so a narrowed type here would be an
// inconsistency nothing catches.)
export function getViewShot(): ViewShotModule | null {
  return null;
}

export function getSharing(): SharingModule | null {
  return null;
}
