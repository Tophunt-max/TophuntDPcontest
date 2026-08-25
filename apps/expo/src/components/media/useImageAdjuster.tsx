import React, { useCallback, useRef, useState } from 'react';
import { ImageAdjuster } from './ImageAdjuster';

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
      setReq({ uri, aspect });
    });
  }, []);

  const host = req ? (
    <ImageAdjuster
      uri={req.uri}
      aspect={req.aspect}
      onCancel={() => finish(null)}
      onDone={(uri) => finish(uri)}
    />
  ) : null;

  return { adjust, host };
}
