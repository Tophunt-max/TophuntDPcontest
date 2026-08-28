import React, { useCallback, useRef, useState } from 'react';
import { ImageAdjuster } from './ImageAdjuster';
import { createPhotoAdjustSession } from '@/src/lib/photoAdjustSession';

/**
 * Awaitable photo-adjust step, so a screen can crop a picked image with two
 * lines instead of threading modal state through its render.
 *
 * Usage:
 *   const { adjust, host } = useImageAdjuster();
 *   // ...after picking an image:
 *   const finalUri = await adjust(pickedUri, 9 / 16);
 *   if (finalUri) setMedia(finalUri);   // null = user cancelled
 *   // ...and render {host} once, anywhere in the tree.
 *
 * The promise resolves with the cropped uri, or null if the user backed out.
 * `host` is the full-screen overlay; it renders nothing until `adjust` is called,
 * so it is free to mount unconditionally.
 */
export function useImageAdjuster() {
  const [req, setReq] = useState<{ uri: string; aspect: number } | null>(null);
  const resolveRef = useRef<((uri: string | null) => void) | null>(null);
  const nonce = useRef(0);

  const finish = useCallback((uri: string | null) => {
    const resolve = resolveRef.current;
    resolveRef.current = null;
    setReq(null);
    resolve?.(uri);
  }, []);

  const adjust = useCallback((uri: string, aspect: number): Promise<string | null> => {
    // If a previous request is somehow still open, resolve it null before
    // replacing it, so no awaiter is left hanging.
    if (resolveRef.current) {
      resolveRef.current(null);
      resolveRef.current = null;
    }
    return new Promise<string | null>((resolve) => {
      resolveRef.current = resolve;
      nonce.current += 1;
      setReq({ uri, aspect });
    });
  }, []);

  const host = req ? (
    // `key` forces a fresh mount per request. Without it, re-adjusting the SAME
    // uri reuses the previous instance, so the pan/zoom shared values keep the
    // last crop's transform and the frame opens mid-zoom instead of reset.
    <ImageAdjuster
      key={nonce.current}
      uri={req.uri}
      aspect={req.aspect}
      onCancel={() => finish(null)}
      onDone={(uri) => finish(uri)}
    />
  ) : null;

  return { adjust, host };
}

/**
 * Adjust that stays available after the first time.
 *
 * `useImageAdjuster` alone pushed every caller into the same shape:
 *
 *     const picked   = result.assets[0].uri;
 *     const adjusted = await adjust(picked, aspect);
 *     setMedia(adjusted ?? picked);
 *
 * which has two defects that were live in all four call sites:
 *
 *  1. NO WAY BACK IN. `adjust` is only reachable in the instant after picking,
 *     so closing the adjuster — deliberately or by accident — left the photo
 *     un-adjustable. The only recovery was to pick the whole image again, and on
 *     the profile screen that meant re-opening the camera.
 *  2. RE-ADJUSTING WOULD COMPOUND. The state holds the CROPPED uri, so a naive
 *     "Adjust" button would crop the crop: quality degrades each time and the
 *     user can never zoom back out to recover what was cropped away.
 *
 * This hook fixes both by remembering the ORIGINAL alongside whatever the screen
 * chose to display. Re-adjustment always starts from that original, so it is
 * lossless and fully reversible however many times it is used.
 *
 * The screen keeps owning its own display/upload state — this only adds the
 * memory needed to reopen the adjuster.
 *
 *   const { adjustPicked, readjust, canReadjust, host } = useReadjustablePhoto(1);
 *   // on pick:      setAvatar(await adjustPicked(picked));
 *   // on "Adjust":  const next = await readjust(); if (next) setAvatar(next);
 */
export function useReadjustablePhoto(aspect: number) {
  const { adjust, host } = useImageAdjuster();
  const [canReadjust, setCanReadjust] = useState(false);
  // The session holds the remembered original. Kept in a ref (not state) because
  // it must be readable by the callbacks below without re-rendering; `canReadjust`
  // is the render-visible projection of it.
  const session = useRef(createPhotoAdjustSession()).current;

  const adjustPicked = useCallback(
    async (picked: string): Promise<string> => {
      session.remember(picked);
      setCanReadjust(true);
      const out = await adjust(picked, aspect);
      return out ?? picked;
    },
    [adjust, aspect, session],
  );

  /** Reopen on the ORIGINAL. Returns the new uri, or null if cancelled. */
  const readjust = useCallback(async (): Promise<string | null> => {
    const source = session.source();
    if (!source) return null;
    return adjust(source, aspect);
  }, [adjust, aspect, session]);

  /** Forget the remembered original — call when the photo is removed. */
  const forget = useCallback(() => {
    session.forget();
    setCanReadjust(false);
  }, [session]);

  return { adjustPicked, readjust, canReadjust, forget, host };
}
