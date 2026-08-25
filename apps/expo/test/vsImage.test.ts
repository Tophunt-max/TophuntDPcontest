/**
 * The composite battle card: what it sends, and how it fails.
 *
 * Everything in `src/lib/vsImage.ts` sits on top of two NATIVE modules that are
 * legitimately absent much of the time — on web, and on every install that has not
 * been rebuilt since they were added. So the contract worth pinning is not just
 * "it captures an image": it is that nothing here ever throws into a caller, that
 * sharing always does *something*, and that a lost race resolves to the card the
 * server actually kept.
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
  shareVsCard,
  uploadAndRecordVsCard,
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

describe('uploadAndRecordVsCard', () => {
  it('uploads into the vs-cards folder and records the returned url', async () => {
    // The folder is load-bearing, not cosmetic: the Worker only accepts a recorded
    // url under `vs-cards/images/`, and only allows uploads to folders on its
    // allow-list. Anything else is a 400 at one end or the other.
    uploadToR2.mockResolvedValue('https://cdn.test/vs-cards/images/abc.jpg');
    callApi.mockResolvedValue({ success: true, vsImageUrl: 'https://cdn.test/vs-cards/images/abc.jpg' });

    const out = await uploadAndRecordVsCard('file:///tmp/card.jpg', 'match-1');

    expect(uploadToR2).toHaveBeenCalledWith('file:///tmp/card.jpg', 'image/jpeg', 'vs-cards');
    expect(callApi).toHaveBeenCalledWith('setMatchVsImage', {
      matchId: 'match-1',
      imageUrl: 'https://cdn.test/vs-cards/images/abc.jpg',
    });
    expect(out).toBe('https://cdn.test/vs-cards/images/abc.jpg');
  });

  it('resolves to the winning card when this client lost the race', async () => {
    // First writer wins server-side, and the loser's upload is deleted there. So
    // returning our own url would name a picture no story points at and that no
    // longer exists.
    uploadToR2.mockResolvedValue('https://cdn.test/vs-cards/images/mine.jpg');
    callApi.mockResolvedValue({
      success: true,
      alreadySet: true,
      vsImageUrl: 'https://cdn.test/vs-cards/images/theirs.jpg',
    });

    expect(await uploadAndRecordVsCard('file:///tmp/card.jpg', 'm')).toBe(
      'https://cdn.test/vs-cards/images/theirs.jpg',
    );
  });

  it('swallows an upload failure and never tries to record it', async () => {
    uploadToR2.mockRejectedValue(new Error('offline'));
    await expect(uploadAndRecordVsCard('file:///tmp/card.jpg', 'm')).resolves.toBeNull();
    expect(callApi).not.toHaveBeenCalled();
  });

  it('swallows a rejected record instead of leaving the caller to handle it', async () => {
    uploadToR2.mockResolvedValue('https://cdn.test/vs-cards/images/abc.jpg');
    callApi.mockRejectedValue(new Error('permission-denied'));
    await expect(uploadAndRecordVsCard('file:///tmp/card.jpg', 'm')).resolves.toBeNull();
  });
});

describe('shareVsCard', () => {
  it('sends the file and does NOT also run the text fallback', async () => {
    // Running both would open two share sheets back to back.
    const shareAsync = vi.fn().mockResolvedValue(undefined);
    sharing = { isAvailableAsync: async () => true, shareAsync };
    const fallbackShare = vi.fn();

    await shareVsCard({ imageUri: 'file:///tmp/card.jpg', fallbackShare });

    expect(shareAsync).toHaveBeenCalledWith('file:///tmp/card.jpg', expect.objectContaining({ mimeType: 'image/jpeg' }));
    expect(fallbackShare).not.toHaveBeenCalled();
  });

  it('falls back to text when there is no image to send', async () => {
    // Sharing is the whole point of producing the card, so it has to still work on
    // web, on a pre-rebuild install, and when the capture simply failed.
    sharing = { isAvailableAsync: async () => true, shareAsync: vi.fn() };
    const fallbackShare = vi.fn();
    await shareVsCard({ imageUri: null, fallbackShare });
    expect(fallbackShare).toHaveBeenCalledTimes(1);
  });

  it('falls back when the native share module is missing', async () => {
    const fallbackShare = vi.fn();
    await shareVsCard({ imageUri: 'file:///tmp/card.jpg', fallbackShare });
    expect(fallbackShare).toHaveBeenCalledTimes(1);
  });

  it('falls back for a remote url, which the share sheet cannot attach', async () => {
    const shareAsync = vi.fn();
    sharing = { isAvailableAsync: async () => true, shareAsync };
    const fallbackShare = vi.fn();

    await shareVsCard({ imageUri: 'https://cdn.test/vs-cards/images/abc.jpg', fallbackShare });

    expect(shareAsync).not.toHaveBeenCalled();
    expect(fallbackShare).toHaveBeenCalledTimes(1);
  });

  it('shares a web blob: capture the same way it shares a native file://', async () => {
    // The web build produces a `blob:` object URL from html-to-image rather than a
    // `file://` tmpfile. It is just as local and attachable, so it must take the
    // image path, not the text fallback — this is the whole point of enabling the
    // composite on web.
    const shareAsync = vi.fn().mockResolvedValue(undefined);
    sharing = { isAvailableAsync: async () => true, shareAsync };
    const fallbackShare = vi.fn();

    await shareVsCard({ imageUri: 'blob:https://app.tophunt.in/9f2c-abc', fallbackShare });

    expect(shareAsync).toHaveBeenCalledWith(
      'blob:https://app.tophunt.in/9f2c-abc',
      expect.objectContaining({ mimeType: 'image/jpeg' }),
    );
    expect(fallbackShare).not.toHaveBeenCalled();
  });

  it('falls back when the device reports no share sheet', async () => {
    const shareAsync = vi.fn();
    sharing = { isAvailableAsync: async () => false, shareAsync };
    const fallbackShare = vi.fn();

    await shareVsCard({ imageUri: 'file:///tmp/card.jpg', fallbackShare });

    expect(shareAsync).not.toHaveBeenCalled();
    expect(fallbackShare).toHaveBeenCalledTimes(1);
  });

  it('falls back when the share sheet itself throws', async () => {
    sharing = { isAvailableAsync: async () => true, shareAsync: vi.fn().mockRejectedValue(new Error('no activity')) };
    const fallbackShare = vi.fn();

    await shareVsCard({ imageUri: 'file:///tmp/card.jpg', fallbackShare });

    expect(fallbackShare).toHaveBeenCalledTimes(1);
  });
});
