/**
 * Where a video upload goes, and — the part that actually broke — what happens
 * when it cannot get there.
 *
 * The two call sites (contest entries and story creation) each used to carry their
 * own copy of this:
 *
 *     try { const v = await uploadToVideoService(...); if (v) ... }
 *     catch (e) { console.warn('falling back to R2', e); }
 *     if (!mediaUrl) await uploadToR2(uri, 'video/mp4', folder);
 *
 * which treats "the encoder is not set up" and "it is set up and failed" as the
 * same event. They are opposites: in the first R2 is the intended destination,
 * in the second R2 has already stopped accepting video — the encoder being live
 * is what closes it — so the retry cannot succeed and the user gets a file-type
 * rejection instead of the real failure. A transient error would also publish a
 * raw, unencoded video, which is the thing the split exists to prevent.
 *
 * Consolidating that decision then introduced the opposite bug: propagating EVERY
 * throw meant a failure of the `createVideoUpload` call itself — a 5xx, a dropped
 * connection, a token refresh — failed an upload that used to succeed on R2, on
 * the very deployment configuration production runs today. Hence the three-way
 * outcome, and hence these tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const videoMock = vi.hoisted(() => ({ impl: vi.fn() }));
const r2Mock = vi.hoisted(() => ({ impl: vi.fn() }));

vi.mock('@/src/services/video/qencodeUpload', () => ({
  uploadVideoForEncoding: (...args: unknown[]) => videoMock.impl(...args),
}));
vi.mock('@/src/lib/uploadToR2', () => ({
  uploadToR2: (...args: unknown[]) => r2Mock.impl(...args),
  isUploadCancelled: (e: any) => e?.name === 'UploadCancelledError',
}));

import { uploadVideo } from '@/src/services/media/uploadVideo';

const opts = { title: 't', targetType: 'story' as const, r2Folder: 'stories' };

beforeEach(() => {
  videoMock.impl.mockReset();
  r2Mock.impl.mockReset();
  r2Mock.impl.mockResolvedValue('https://media.tophunt.in/stories/2026/08/a.mp4');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('uploadVideo', () => {
  it('returns the encoded playback URL and never touches R2', async () => {
    videoMock.impl.mockResolvedValue({
      status: 'uploaded',
      provider: 'qencode',
      videoId: 'id',
      playbackUrl: 'https://media.tophunt.in/videos/id/playlist.m3u8',
      thumbnailUrl: null,
    });

    await expect(uploadVideo('file://v.mp4', opts)).resolves.toBe(
      'https://media.tophunt.in/videos/id/playlist.m3u8',
    );
    expect(r2Mock.impl).not.toHaveBeenCalled();
  });

  it('uses R2 when the encoder is not configured and that path is still open', async () => {
    videoMock.impl.mockResolvedValue({ status: 'not-configured', r2Fallback: true });

    await expect(uploadVideo('file://v.mp4', opts)).resolves.toContain('/stories/');
    // 'video/mp4' means "a video is expected", not "this file is an mp4" — the real
    // container is read from the file header server-side.
    expect(r2Mock.impl).toHaveBeenCalledWith('file://v.mp4', 'video/mp4', 'stories', undefined, { signal: undefined });
  });

  it('does NOT retry on R2 once the encoder is live and the upload fails', async () => {
    // The regression this guards: retrying here would either hit a confusing
    // file-type rejection or, worse, publish a raw unencoded video.
    videoMock.impl.mockRejectedValue(new Error('Upload failed (status 500).'));

    await expect(uploadVideo('file://v.mp4', opts)).rejects.toThrow('Upload failed (status 500).');
    expect(r2Mock.impl).not.toHaveBeenCalled();
  });

  it('still falls back to R2 when createVideoUpload itself could not be reached', async () => {
    // Nothing was created, so this says nothing about whether the encoder is live —
    // and before the split this case succeeded on R2. It must keep doing so.
    videoMock.impl.mockResolvedValue({ status: 'unavailable', error: new Error('offline') });

    await expect(uploadVideo('file://v.mp4', opts)).resolves.toContain('/stories/');
    expect(r2Mock.impl).toHaveBeenCalledTimes(1);
  });

  it('surfaces a 4xx from createVideoUpload without re-uploading to R2', async () => {
    // The rate limit (10 video uploads/hour) is the one users actually hit. A 4xx
    // is an answer from PAST the `qencodeConfigured()` gate — the action returns 200
    // with `configured: false` when the encoder is off — so it is live, R2 is closed,
    // and the fallback would push the whole file over mobile data to be refused.
    const rateLimited = Object.assign(new Error('You have started too many video uploads'), {
      code: 'functions/resource-exhausted',
      status: 429,
    });
    videoMock.impl.mockResolvedValue({ status: 'unavailable', error: rateLimited });

    await expect(uploadVideo('file://v.mp4', opts)).rejects.toThrow(/too many video uploads/i);
    expect(r2Mock.impl).not.toHaveBeenCalled();
  });

  it('reports the real failure, not R2\'s "update the app", when the fallback is refused', async () => {
    // The exact bug users saw on /story/create: a current build asked the server, got no
    // answer, retried R2, and R2's message for STALE clients became the visible
    // error — telling them to update an already-current app and hiding the cause.
    videoMock.impl.mockResolvedValue({
      status: 'unavailable',
      error: new Error('The server took too long to respond. Please try again.'),
    });
    r2Mock.impl.mockRejectedValue(
      new Error(
        'Videos are no longer uploaded to this endpoint. Use the createVideoUpload action and ' +
          'POST /upload/video. Please update the app.',
      ),
    );

    await expect(uploadVideo('file://v.mp4', opts)).rejects.toThrow(/took too long to respond/i);
    await expect(uploadVideo('file://v.mp4', opts)).rejects.not.toThrow(/update the app/i);
  });

  it('refuses rather than guessing when the server closed both paths', async () => {
    videoMock.impl.mockResolvedValue({ status: 'not-configured', r2Fallback: false });

    await expect(uploadVideo('file://v.mp4', opts)).rejects.toThrow(/temporarily unavailable/i);
    expect(r2Mock.impl).not.toHaveBeenCalled();
  });
});
