/**
 * The remembered-original state machine behind "Adjust photo".
 *
 * Lives here, in a plain module with no React and no JSX, for the same reason
 * `cropMath.ts` does: it is the part with a rule that can be got wrong silently,
 * so it should be unit-testable without a renderer or a gesture engine.
 *
 * ---------------------------------------------------------------------------
 * The rule
 * ---------------------------------------------------------------------------
 * A re-adjust must always crop the ORIGINAL picked image, never the previous
 * crop.
 *
 * This is the whole reason the module exists. Every screen stores the *cropped*
 * uri — that is what gets displayed and uploaded — so the obvious implementation
 * of an "Adjust" button re-crops whatever is on screen. That version looks
 * correct and is not: each pass throws away pixels, resolution degrades every
 * time, and the user can never zoom back out to recover the part they cropped
 * off. Keeping the original is what makes repeated adjustment lossless and fully
 * reversible.
 *
 * Used by `useReadjustablePhoto` in components/media/useImageAdjuster.tsx.
 */

export interface PhotoAdjustSession {
  /**
   * Record a freshly PICKED uri.
   *
   * Never call this with a cropped result — that is precisely the mistake this
   * module exists to prevent.
   */
  remember(uri: string): void;
  /** What a re-adjust must operate on, or null when there is nothing to re-crop. */
  source(): string | null;
  /** Drop the remembered original — call when the photo is removed. */
  forget(): void;
}

/**
 * One session per picker.
 *
 * Deliberately a factory rather than module-level state: two pickers can be
 * mounted at once (an avatar and a story), and a shared original would let one
 * screen re-crop the other's photo.
 */
export function createPhotoAdjustSession(): PhotoAdjustSession {
  let original: string | null = null;
  return {
    remember(uri: string) {
      original = uri;
    },
    source() {
      return original;
    },
    forget() {
      original = null;
    },
  };
}
