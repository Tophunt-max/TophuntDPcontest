/**
 * Bunny (tus) uploads resume only into the SAME Bunny video, and can be cancelled.
 *
 * Every attempt creates a new Bunny video. The tus default fingerprint is built
 * from the file, so a retry of the same file found the previous attempt's tus
 * URL and resumed into the OLD video, while this attempt returned its own,
 * empty, playbackUrl.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  created: 0,
  uploads: [] as any[],
  callApi: vi.fn(),
}));

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('@/src/services/api', () => ({ callApi: (...a: any[]) => h.callApi(...a) }));
vi.mock('@/src/services/video/tusUrlStorage', () => ({ tusUrlStorage: {} }));
vi.mock('@/src/lib/uploadToR2', () => {
  class UploadCancelledError extends Error {
    constructor() {
      super('Upload cancelled.');
      this.name = 'UploadCancelledError';
    }
  }
  return { UploadCancelledError };
});
vi.mock('tus-js-client', () => {
  class Upload {
    options: any;
    started = false;
    aborted: boolean | null = null;
    constructor(_file: any, options: any) {
      this.options = options;
      h.uploads.push(this);
    }
    async findPreviousUploads() {
      return [];
    }
    resumeFromPreviousUpload() {}
    start() {
      this.started = true;
    }
    async abort(terminate: boolean) {
      this.aborted = terminate;
    }
  }
  return { Upload };
});

const { uploadVideoToBunny } = await import('@/src/services/video/bunnyUpload');

beforeEach(() => {
  h.created = 0;
  h.uploads = [];
  h.callApi.mockReset();
  h.callApi.mockImplementation(async (action: string) => {
    if (action === 'createVideoUpload') {
      h.created++;
      return {
        configured: true,
        videoId: `guid-${h.created}`,
        libraryId: '1',
        expirationTime: 9_999_999_999,
        signature: 'sig',
        playbackUrl: `https://vz.test/guid-${h.created}/playlist.m3u8`,
      };
    }
    return { success: true };
  });
  vi.stubGlobal('fetch', async () => ({ ok: true, blob: async () => new Blob([new Uint8Array(10)], { type: 'video/mp4' }) }));
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('Bunny tus upload', () => {
  it('two attempts of the same file get different resume keys, one per Bunny video', async () => {
    const first = uploadVideoToBunny('file://same.mp4');
    await flush();
    await flush();
    h.uploads[0].options.onSuccess();
    await first;
    const second = uploadVideoToBunny('file://same.mp4');
    await flush();
    await flush();
    h.uploads[1].options.onSuccess();
    const out: any = await second;

    const fp0 = await h.uploads[0].options.fingerprint();
    const fp1 = await h.uploads[1].options.fingerprint();
    expect(fp0).toBe('bunny-guid-1');
    expect(fp1).toBe('bunny-guid-2');
    expect(out.playbackUrl).toBe('https://vz.test/guid-2/playlist.m3u8');
    expect(h.uploads[1].options.removeFingerprintOnSuccess).toBe(true);
  });

  it('cancelling aborts the tus upload (terminating it) and rejects as cancelled', async () => {
    const ac = new AbortController();
    const p = uploadVideoToBunny('file://v.mp4', { signal: ac.signal });
    await flush();
    await flush();
    ac.abort();
    const err: any = await p.catch((e) => e);
    expect(err?.name).toBe('UploadCancelledError');
    expect(h.uploads[0].aborted).toBe(true);
    expect(h.callApi).not.toHaveBeenCalledWith('videoUploadComplete', expect.anything());
  });

  it('an already-cancelled signal never creates a Bunny video', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(uploadVideoToBunny('file://v.mp4', { signal: ac.signal })).rejects.toMatchObject({ name: 'UploadCancelledError' });
    expect(h.created).toBe(0);
  });
});
