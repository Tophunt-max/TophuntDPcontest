/**
 * The client half of the Qencode upload protocol.
 *
 * Pinned:
 *  - the request says `upload: "worker"`, which is how the server tells this
 *    build apart from Bunny-era builds (it answers those "not configured");
 *  - the bytes go to the path the SERVER returned, never one built here;
 *  - "not configured" and "could not ask" stay distinct outcomes, because
 *    `uploadVideo` falls back to R2 differently for each;
 *  - cancellation before or during the call reports a cancellation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const apiMock = vi.hoisted(() => ({ impl: vi.fn() }));
const sendMock = vi.hoisted(() => ({ impl: vi.fn() }));

vi.mock('@/src/services/api', () => ({
  callApi: (...args: unknown[]) => apiMock.impl(...args),
}));
vi.mock('@/src/lib/uploadToR2', () => {
  class UploadCancelledError extends Error {
    constructor() {
      super('Upload cancelled.');
      this.name = 'UploadCancelledError';
    }
  }
  return {
    UploadCancelledError,
    uploadVideoSource: (...args: unknown[]) => sendMock.impl(...args),
  };
});

import { uploadVideoForEncoding } from '@/src/services/video/qencodeUpload';

const ID = '0f8b3b7e-1234-4cde-9abc-0123456789ab';
const PLAYLIST = `https://media.tophunt.in/videos/${ID}/playlist.m3u8`;

beforeEach(() => {
  apiMock.impl.mockReset();
  sendMock.impl.mockReset();
});

describe('uploadVideoForEncoding', () => {
  it('announces the worker-upload protocol and sends the bytes to the server-given path', async () => {
    apiMock.impl.mockResolvedValue({
      configured: true,
      provider: 'qencode',
      videoId: ID,
      uploadPath: `/upload/video?videoId=${ID}`,
      playbackUrl: PLAYLIST,
      thumbnailUrl: `https://media.tophunt.in/videos/${ID}/thumbnail.jpg`,
    });
    sendMock.impl.mockResolvedValue(PLAYLIST);
    const onProgress = vi.fn();

    const out = await uploadVideoForEncoding('file://v.mp4', { targetType: 'story', onProgress });

    expect(apiMock.impl).toHaveBeenCalledWith('createVideoUpload', { upload: 'worker', targetType: 'story' });
    expect(sendMock.impl).toHaveBeenCalledWith('file://v.mp4', `/upload/video?videoId=${ID}`, onProgress, { signal: undefined });
    expect(out).toMatchObject({ status: 'uploaded', provider: 'qencode', videoId: ID, playbackUrl: PLAYLIST });
  });

  it('reports not-configured with the server\'s fallback answer, sending nothing', async () => {
    apiMock.impl.mockResolvedValue({ configured: false, r2Fallback: false });

    await expect(uploadVideoForEncoding('file://v.mp4')).resolves.toEqual({ status: 'not-configured', r2Fallback: false });
    expect(sendMock.impl).not.toHaveBeenCalled();
  });

  it('defaults the fallback to open when an older Worker omits it', async () => {
    apiMock.impl.mockResolvedValue({ configured: false });
    await expect(uploadVideoForEncoding('file://v.mp4')).resolves.toEqual({ status: 'not-configured', r2Fallback: true });
  });

  it('reports "unavailable" (not a throw) when createVideoUpload itself fails', async () => {
    const error = new Error('offline');
    apiMock.impl.mockRejectedValue(error);
    await expect(uploadVideoForEncoding('file://v.mp4')).resolves.toEqual({ status: 'unavailable', error });
  });

  it('propagates a failed byte upload: the encoder is live, so R2 is no fallback', async () => {
    apiMock.impl.mockResolvedValue({ configured: true, videoId: ID, uploadPath: `/upload/video?videoId=${ID}` });
    sendMock.impl.mockRejectedValue(new Error('File too large (max 80MB).'));
    await expect(uploadVideoForEncoding('file://v.mp4')).rejects.toThrow(/too large/);
  });

  it('reports a cancellation, not a reason to try R2, when aborted while asking', async () => {
    const ac = new AbortController();
    apiMock.impl.mockImplementation(async () => {
      ac.abort();
      throw new Error('aborted');
    });
    await expect(uploadVideoForEncoding('file://v.mp4', { signal: ac.signal })).rejects.toMatchObject({
      name: 'UploadCancelledError',
    });
  });
});
