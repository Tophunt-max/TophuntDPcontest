/**
 * Web build of the VS-card capture/share seam.
 *
 * ---------------------------------------------------------------------------
 * Why this file has real behaviour now
 * ---------------------------------------------------------------------------
 * It used to return `null` for both modules so the web build stayed a viewer:
 * it rendered the battle frame live and shared a text link, but never produced
 * the single composite image. The deliberate reason was bundle size —
 * `react-native-view-shot`'s web path drags in `html2canvas` (~4.5 MB), and
 * nothing here wants the rest of view-shot.
 *
 * The product need won: a battle story should become ONE shareable image on web
 * too, and both participants should end up looking at that same composite. So
 * this file now implements the two seams directly, using `html-to-image` — which
 * is a fraction of html2canvas — instead of pulling in view-shot's web build.
 * `html-to-image` is imported ONLY here, and Metro serves this file only to the
 * web bundle, so the native bundle still carries none of it.
 *
 * ---------------------------------------------------------------------------
 * What still degrades gracefully, and why it must
 * ---------------------------------------------------------------------------
 * DOM-to-image capture can fail for reasons that are normal on the web and not
 * worth surfacing: an entry image served without permissive CORS taints the
 * canvas and makes export throw, and the Web Share API is absent or refuses
 * files on many desktop browsers. Every path below therefore reports failure
 * (null / throw) rather than blocking, exactly like the native seam — the story
 * keeps rendering its live layout and sharing falls back to the text link. The
 * feature is an enhancement of the web experience, never a requirement of it.
 */
import { toCanvas } from 'html-to-image';

import type { ViewShotModule, SharingModule } from './vsNativeModules';

export type { ViewShotModule, SharingModule } from './vsNativeModules';

/**
 * Resolve the DOM node to screenshot from whatever `captureRef` was handed.
 *
 * `react-native-web` forwards a `<View>` ref to its underlying `<div>`, so on web
 * `shotRef.current` is usually the element already. The extra shapes are cheap
 * insurance against a wrapper (a ref object, or an older RNW build exposing the
 * node behind `getNode()`), so a capture never fails merely because the handle
 * arrived one level in.
 */
function resolveDomNode(ref: any): HTMLElement | null {
  if (!ref) return null;
  if (ref.nodeType === 1) return ref as HTMLElement;
  if (ref.current?.nodeType === 1) return ref.current as HTMLElement;
  const viaGetNode = typeof ref.getNode === 'function' ? ref.getNode() : null;
  if (viaGetNode?.nodeType === 1) return viaGetNode as HTMLElement;
  return null;
}

/**
 * Capture a mounted battle frame to a JPEG `blob:` URL.
 *
 * Returns a `blob:` URL, never a `data:` one, and that choice is load-bearing:
 * the uploader reads the result back with `fetch(uri)`, which is governed by the
 * page's CSP `connect-src`. That list allows `blob:` (added when web uploads were
 * first fixed) but not `data:`, so a data URL would be blocked at the fetch and
 * the upload would fail exactly where it is hardest to see.
 *
 * `toCanvas` + `canvas.toBlob('image/jpeg', q)` is used rather than
 * `html-to-image`'s `toBlob`, whose older signature ignores type/quality and
 * always emits PNG — a multi-megabyte, wrong-typed object for a photographic
 * frame. `pixelRatio` is capped so a 3x retina screen does not produce a
 * needlessly huge upload.
 */
async function captureRef(ref: any, opts?: { quality?: number }): Promise<string> {
  const node = resolveDomNode(ref);
  if (!node) throw new Error('VS capture: no DOM node to screenshot.');

  const quality = typeof opts?.quality === 'number' ? opts.quality : 0.92;
  const pixelRatio = Math.min((typeof window !== 'undefined' && window.devicePixelRatio) || 1, 2);

  const canvas = await toCanvas(node, {
    // Flatten transparency to the story's dark background rather than to JPEG's
    // default black, so any gap around the frame matches what is on screen.
    backgroundColor: '#1B1226',
    pixelRatio,
    // Re-fetch entry images with a cache-buster so a previously cached response
    // without CORS headers is not what taints the canvas.
    cacheBust: true,
  });

  const blob: Blob = await new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('VS capture: canvas produced no image (likely a CORS-tainted entry image).'))),
      'image/jpeg',
      quality,
    );
  });

  return URL.createObjectURL(blob);
}

/** Free a `blob:` URL from `captureRef`. Safe with anything, including a non-blob URL. */
function releaseCapture(uri: string): void {
  try {
    if (typeof uri === 'string' && uri.startsWith('blob:')) URL.revokeObjectURL(uri);
  } catch {
    /* revoking an already-revoked or foreign url is not worth reporting */
  }
}

export function getViewShot(): ViewShotModule | null {
  // Guard the DOM APIs so a non-browser web context (SSR/prerender) reports the
  // feature as unavailable instead of throwing at module load.
  if (typeof document === 'undefined') return null;
  return { captureRef, releaseCapture };
}

/**
 * Share a captured card as a real image file via the Web Share API.
 *
 * `isAvailableAsync` is the gate the caller (`shareVsCard`) checks first, and it
 * is honest about files specifically: `navigator.share` exists on some desktop
 * browsers that cannot attach a file, so we probe `canShare({ files })` with a
 * tiny throwaway file. When that is false the caller falls back to the text
 * share, which is the right outcome — a share sheet that can only send a link is
 * what the fallback already does, better.
 */
function shareModule(): SharingModule {
  const canShareFiles = (): boolean => {
    try {
      if (typeof navigator === 'undefined' || typeof navigator.share !== 'function') return false;
      if (typeof navigator.canShare !== 'function') return false;
      const probe = new File([new Blob([''], { type: 'image/jpeg' })], 'probe.jpg', { type: 'image/jpeg' });
      return navigator.canShare({ files: [probe] });
    } catch {
      return false;
    }
  };

  return {
    isAvailableAsync: async () => canShareFiles(),
    shareAsync: async (url: string, sharingOpts?: any) => {
      // The url is a local blob: from captureRef. Read it back into a File the
      // Web Share API can attach. fetch(blob:) is permitted by connect-src.
      const res = await fetch(url);
      const blob = await res.blob();
      const file = new File([blob], 'battle.jpg', { type: blob.type || 'image/jpeg' });
      if (typeof navigator.canShare === 'function' && !navigator.canShare({ files: [file] })) {
        // Let the caller fall back to text rather than opening a link-only sheet.
        throw new Error('This browser cannot share an image file.');
      }
      await navigator.share({
        files: [file],
        title: sharingOpts?.dialogTitle || 'Share this battle',
      });
    },
  };
}

export function getSharing(): SharingModule | null {
  if (typeof navigator === 'undefined') return null;
  return shareModule();
}
