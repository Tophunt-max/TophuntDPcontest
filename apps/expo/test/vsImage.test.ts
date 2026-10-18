/**
 * The composite battle card: what it sends, and how it fails.
 *
 * Everything in `src/lib/vsImage.ts` sits on top of two NATIVE modules that are
 * legitimately absent much of the time — on web, and on every install that has not
 * been rebuilt since they were added. So the contract worth pinning is not just
 * "it captures an image": it is that nothing here ever throws into a caller and
 * that sharing always does *something*. (Recording a card is no longer a client
 * job — the server renders it — so there is no upload path left to test here.)
 *
 * The native modules are reached through the `vsNativeModules` seam, which exists
 * to keep them out of the web bundle — and, usefully, makes both the present and
 * absent branches reachable from a plain Node test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// `vi.mock` calls are hoisted above this by Vitest, so the mocks below are in
// place before the module under test is evaluated.
import {
  captureVsCard,
  isVsCaptureSupported,
} from '@/src/lib/vsImage';

let viewShot: any = null;
let sharing: any = null;
vi.mock('@/src/lib/vsNativeModules', () => ({
  getViewShot: () => viewShot,
  getSharing: () => sharing,
}));

const uploadToR2 = vi.fn();
vi.mock('@/src/lib/uploadToR2', () => ({ uploadToR2: (...a: any[]) => uploadToR2(...a) }));

const callApi = vi.fn();
vi.mock('@/src/services/api', () => ({ callApi: (...a: any[]) => callApi(...a) }));

beforeEach(() => {
  viewShot = null;
  sharing = null;
  uploadToR2.mockReset();
  callApi.mockReset();
  // The helpers log on every swallowed failure, which is right in production and
  // noise here.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isVsCaptureSupported', () => {
  it('is false when the native module is absent — web, or a pre-rebuild install', async () => {
    // Callers use this to skip mounting the capture wrapper at all, not to decide
    // whether to handle failure, which they must do regardless.
    expect(isVsCaptureSupported()).toBe(false);
  });

  it('is false when the module loads but exposes no captureRef', async () => {
    // A partially linked native module resolves to an object rather than throwing,
    // so presence alone is not something to act on.
    viewShot = {};
    expect(isVsCaptureSupported()).toBe(false);
  });

  it('is true once the module is really there', async () => {
    viewShot = { captureRef: async () => 'file:///tmp/card.jpg' };
    expect(isVsCaptureSupported()).toBe(true);
  });
});

describe('captureVsCard', () => {
  it('returns null instead of throwing when there is nothing to capture', async () => {
    viewShot = { captureRef: async () => 'file:///tmp/card.jpg' };
    await expect(captureVsCard(null)).resolves.toBeNull();
    await expect(captureVsCard(undefined)).resolves.toBeNull();
  });

  it('returns null when the module is missing, without touching the ref', async () => {
    await expect(captureVsCard({ some: 'ref' })).resolves.toBeNull();
  });

  it('captures a JPEG to a temp file rather than a base64 string', async () => {
    // Both matter. A full-screen lossless capture is several megabytes to upload
    // and serve; a base64 result holds the whole image in JS memory twice, and
    // neither the uploader nor the share sheet can use it.
    const captureRef = vi.fn().mockResolvedValue('file:///tmp/card.jpg');
    viewShot = { captureRef };

    await expect(captureVsCard({ some: 'ref' })).resolves.toBe('file:///tmp/card.jpg');
    expect(captureRef).toHaveBeenCalledWith({ some: 'ref' }, { format: 'jpg', quality: 0.92, result: 'tmpfile' });
  });

  it('swallows a capture failure — the frame on screen is still correct', async () => {
    viewShot = { captureRef: vi.fn().mockRejectedValue(new Error('view not found')) };
    await expect(captureVsCard({ some: 'ref' })).resolves.toBeNull();
  });
});
