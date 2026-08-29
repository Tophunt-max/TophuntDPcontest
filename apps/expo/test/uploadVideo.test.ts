/**
 * Where a video upload goes, and — the part that actually broke — what happens
 * when it cannot get there.
 *
 * The two call sites (contest entries and story creation) each used to carry their
 * own copy of this:
 *
 *     try { const bunny = await uploadVideoToBunny(...); if (bunny) ... }
 *     catch (e) { console.warn('falling back to R2', e); }
 *     if (!mediaUrl) await uploadToR2(uri, 'video/mp4', folder);
 *
 * which treats "Bunny is not set up" and "Bunny is set up and failed" as the same
 * event. They are opposites: in the first R2 is the intended destination, in the
 * second R2 has already stopped accepting video — Bunny being configured is what
 * closes it — so the retry cannot succeed and the user gets a file-type rejection
 * instead of the real failure. A transient Bunny error would also quietly put a
 * video in the image bucket, which is the thing the split exists to prevent.
 *
 * Consolidating that decision then introduced the opposite bug: propagating EVERY
 * throw meant a failure of the `createVideoUpload` call itself — a 5xx, a dropped
 * connection, a token refresh — failed an upload that used to succeed on R2, on
 * the very deployment configuration production runs today. Hence the three-way
 * outcome, and hence these tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const bunnyMock = vi.hoisted(() => ({ impl: vi.fn() }));
const r2Mock = vi.hoisted(() => ({ impl: vi.fn() }));

vi.mock('@/src/services/video/bunnyUpload', () => ({
  uploadVideoToBunny: (...args: unknown[]) => bunnyMock.impl(...args),
}));
vi.mock('@/src/lib/uploadToR2', () => ({
  uploadToR2: (...args: unknown[]) => r2Mock.impl(...args),
}));

import { uploadVideo } from '@/src/services/media/uploadVideo';

const opts = { title: 't', targetType: 'story' as const, r2Folder: 'stories' };

beforeEach(() => {
  bunnyMock.impl.mockReset();
  r2Mock.impl.mockReset();
  r2Mock.impl.mockResolvedValue('https://media.tophunt.in/stories/2026/08/a.mp4');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('uploadVideo', () => {
  it('returns the Bunny playback URL and never touches R2', async () => {
    bunnyMock.impl.mockResolvedValue({
      status: 'uploaded',
      provider: 'bunny',
      videoId: 'guid',
      playbackUrl: 'https://vz-x.b-cdn.net/guid/playlist.m3u8',
      thumbnailUrl: null,
    });

    await expect(uploadVideo('file://v.mp4', opts)).resolves.toBe(
      'https://vz-x.b-cdn.net/guid/playlist.m3u8',
    );
    expect(r2Mock.impl).not.toHaveBeenCalled();
  });

  it('uses R2 when Bunny is not configured and that path is still open', async () => {
    bunnyMock.impl.mockResolvedValue({ status: 'not-configured', r2Fallback: true });

    await expect(uploadVideo('file://v.mp4', opts)).resolves.toContain('/stories/');
    // 'video/mp4' means "a video is expected", not "this file is an mp4" — the real
    // container is read from the file header server-side.
    expect(r2Mock.impl).toHaveBeenCalledWith('file://v.mp4', 'video/mp4', 'stories', undefined);
  });

  it('does NOT retry on R2 once Bunny is live and the upload fails', async () => {
    // The regression this guards: retrying here would either hit a confusing
    // file-type rejection or, worse, land a video in the image bucket.
    bunnyMock.impl.mockRejectedValue(new Error('bunny tus 500'));

    await expect(uploadVideo('file://v.mp4', opts)).rejects.toThrow('bunny tus 500');
    expect(r2Mock.impl).not.toHaveBeenCalled();
  });

  it('still falls back to R2 when createVideoUpload itself could not be reached', async () => {
    // No Bunny session exists, so this says nothing about whether Bunny is live —
    // and before the split this case succeeded on R2. It must keep doing so.
    bunnyMock.impl.mockResolvedValue({ status: 'unavailable', error: new Error('offline') });

    await expect(uploadVideo('file://v.mp4', opts)).resolves.toContain('/stories/');
    expect(r2Mock.impl).toHaveBeenCalledTimes(1);
  });

  it('refuses rather than guessing when the server closed both paths', async () => {
    bunnyMock.impl.mockResolvedValue({ status: 'not-configured', r2Fallback: false });

    await expect(uploadVideo('file://v.mp4', opts)).rejects.toThrow(/temporarily unavailable/i);
    expect(r2Mock.impl).not.toHaveBeenCalled();
  });
});
