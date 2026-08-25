/**
 * The web capture/share seam.
 *
 * This is the file that makes a battle become one shareable image on web, and it
 * is all edges: it decides whether the feature is even available, turns a DOM
 * node into a `blob:` URL the uploader can read, and gates sharing on whether the
 * browser can attach a file. None of that runs on native, and all of it fails in
 * ways that must degrade quietly rather than throw into a screen.
 *
 * The tests stub the browser globals the module touches (document, navigator,
 * URL, fetch) so the whole thing is exercisable from plain Node.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const toCanvas = vi.fn();
vi.mock('html-to-image', () => ({ toCanvas: (...a: any[]) => toCanvas(...a) }));

import { getViewShot, getSharing } from '@/src/lib/vsNativeModules.web';

/** A canvas stub whose toBlob yields a JPEG blob (or null to model a CORS taint). */
function fakeCanvas(blob: Blob | null) {
  return {
    toBlob: (cb: (b: Blob | null) => void, _type?: string, _q?: number) => cb(blob),
  };
}

beforeEach(() => {
  toCanvas.mockReset();
  vi.stubGlobal('document', {});
  vi.stubGlobal('window', { devicePixelRatio: 3 });
  vi.stubGlobal('URL', {
    createObjectURL: vi.fn(() => 'blob:https://app.tophunt.in/generated'),
    revokeObjectURL: vi.fn(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getViewShot (web capture)', () => {
  it('is unavailable in a non-browser context', () => {
    vi.stubGlobal('document', undefined);
    expect(getViewShot()).toBeNull();
  });

  it('exposes captureRef + releaseCapture in the browser', () => {
    const mod = getViewShot();
    expect(typeof mod?.captureRef).toBe('function');
    expect(typeof mod?.releaseCapture).toBe('function');
  });

  it('captures a DOM node to a blob: URL, never a data: URL', async () => {
    // blob: is deliberate — the uploader reads the result with fetch(), which the
    // page CSP allows for blob: but not data:.
    toCanvas.mockResolvedValue(fakeCanvas(new Blob(['jpegbytes'], { type: 'image/jpeg' })));
    const mod = getViewShot()!;

    const uri = await mod.captureRef!({ nodeType: 1 }, { quality: 0.9 });

    expect(uri).toBe('blob:https://app.tophunt.in/generated');
    expect(toCanvas).toHaveBeenCalledTimes(1);
    // The node is passed through, and the retina pixelRatio is capped at 2.
    const [node, opts] = toCanvas.mock.calls[0];
    expect(node).toEqual({ nodeType: 1 });
    expect(opts.pixelRatio).toBe(2);
  });

  it('resolves the node when handed a ref object rather than the element', async () => {
    toCanvas.mockResolvedValue(fakeCanvas(new Blob(['x'], { type: 'image/jpeg' })));
    const mod = getViewShot()!;
    await mod.captureRef!({ current: { nodeType: 1 } });
    expect(toCanvas).toHaveBeenCalledTimes(1);
  });

  it('throws when there is no node to screenshot', async () => {
    const mod = getViewShot()!;
    await expect(mod.captureRef!(null)).rejects.toThrow(/no DOM node/i);
    expect(toCanvas).not.toHaveBeenCalled();
  });

  it('throws a CORS-shaped error when the canvas is tainted (toBlob yields null)', async () => {
    // A cross-origin entry image with no permissive headers taints the canvas, so
    // toBlob returns null. The caller turns this into "keep the live frame".
    toCanvas.mockResolvedValue(fakeCanvas(null));
    const mod = getViewShot()!;
    await expect(mod.captureRef!({ nodeType: 1 })).rejects.toThrow(/CORS|no image/i);
  });

  it('revokes only blob: URLs on release', () => {
    const mod = getViewShot()!;
    mod.releaseCapture!('blob:https://app.tophunt.in/generated');
    expect((URL as any).revokeObjectURL).toHaveBeenCalledWith('blob:https://app.tophunt.in/generated');

    (URL as any).revokeObjectURL.mockClear();
    mod.releaseCapture!('file:///tmp/native.jpg'); // not a web blob
    expect((URL as any).revokeObjectURL).not.toHaveBeenCalled();
  });
});

describe('getSharing (Web Share API)', () => {
  it('is unavailable when there is no navigator', () => {
    vi.stubGlobal('navigator', undefined);
    expect(getSharing()).toBeNull();
  });

  it('reports available only when the browser can share files', async () => {
    vi.stubGlobal('navigator', { share: vi.fn(), canShare: vi.fn(() => true) });
    expect(await getSharing()!.isAvailableAsync!()).toBe(true);

    // share() exists but the browser refuses files (common on desktop).
    vi.stubGlobal('navigator', { share: vi.fn(), canShare: vi.fn(() => false) });
    expect(await getSharing()!.isAvailableAsync!()).toBe(false);

    // No Web Share API at all.
    vi.stubGlobal('navigator', {});
    expect(await getSharing()!.isAvailableAsync!()).toBe(false);
  });

  it('reads the blob back into a File and shares it', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { share, canShare: vi.fn(() => true) });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ blob: async () => new Blob(['jpegbytes'], { type: 'image/jpeg' }) }),
    );

    await getSharing()!.shareAsync!('blob:https://app.tophunt.in/generated', { dialogTitle: 'Share this battle' });

    expect(fetch).toHaveBeenCalledWith('blob:https://app.tophunt.in/generated');
    const arg = share.mock.calls[0][0];
    expect(arg.title).toBe('Share this battle');
    expect(arg.files).toHaveLength(1);
    expect(arg.files[0].type).toBe('image/jpeg');
  });

  it('throws (so the caller falls back to text) when files cannot be shared', async () => {
    // canShare passed the availability probe but refuses this specific file.
    vi.stubGlobal('navigator', { share: vi.fn(), canShare: vi.fn(() => false) });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ blob: async () => new Blob(['x'], { type: 'image/jpeg' }) }),
    );
    await expect(
      getSharing()!.shareAsync!('blob:https://app.tophunt.in/generated'),
    ).rejects.toThrow(/cannot share/i);
  });
});
