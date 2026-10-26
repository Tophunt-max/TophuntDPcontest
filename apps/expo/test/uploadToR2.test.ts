/**
 * Photo/video upload to R2 through the Worker (src/lib/uploadToR2.ts):
 * stall timeout, cancellation and bounded retries, against a scripted XHR.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/src/services/api', () => ({ API_BASE_URL: 'https://api.test' }));
vi.mock('@/src/services/firebase/initFirebase', () => ({
  auth: { currentUser: { getIdToken: async () => 'tok' } },
}));

const { uploadToR2, isUploadCancelled } = await import('@/src/lib/uploadToR2');

type Script = (xhr: FakeXHR) => void;
let scripts: Script[] = [];
let opened: FakeXHR[] = [];

class FakeXHR {
  status = 0;
  responseText = '';
  aborted = false;
  headers: Record<string, string> = {};
  upload: { onprogress: ((e: any) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  open() {
    opened.push(this);
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k] = v;
  }
  send() {
    const s = scripts.shift();
    if (s) setTimeout(() => s(this), 0);
  }
  abort() {
    this.aborted = true;
  }
  ok(url = 'https://cdn.test/stories/a.jpg') {
    this.status = 200;
    this.responseText = JSON.stringify({ publicUrl: url });
    this.onload?.();
  }
  fail(status: number, message = 'nope') {
    this.status = status;
    this.responseText = JSON.stringify({ error: { message } });
    this.onload?.();
  }
}

// A real JPEG header so the client-side sniffer accepts the file.
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1]);

beforeEach(() => {
  scripts = [];
  opened = [];
  vi.stubGlobal('XMLHttpRequest', FakeXHR as any);
  vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, blob: async () => new Blob([JPEG], { type: 'image/jpeg' }) }));
  vi.spyOn(Math, 'random').mockReturnValue(0);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('uploadToR2', () => {
  it('uploads with the detected type and the token', async () => {
    scripts = [(x) => x.ok()];
    await expect(uploadToR2('file://a.jpg', 'image/jpeg', 'stories')).resolves.toBe('https://cdn.test/stories/a.jpg');
    expect(opened).toHaveLength(1);
    expect(opened[0].headers).toMatchObject({ 'Content-Type': 'image/jpeg', Authorization: 'Bearer tok' });
  });

  it('retries a network error and a 503, then succeeds', async () => {
    scripts = [(x) => x.onerror?.(), (x) => x.fail(503), (x) => x.ok()];
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const p = uploadToR2('file://a.jpg', 'image/jpeg', 'stories');
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe('https://cdn.test/stories/a.jpg');
    expect(opened).toHaveLength(3);
  });

  it('does not retry a 4xx refusal (wrong type, too large)', async () => {
    scripts = [(x) => x.fail(413, 'File too large')];
    await expect(uploadToR2('file://a.jpg', 'image/jpeg', 'stories')).rejects.toThrow('File too large');
    expect(opened).toHaveLength(1);
  });

  it('gives up after the retry budget', async () => {
    scripts = [(x) => x.onerror?.(), (x) => x.onerror?.(), (x) => x.onerror?.(), (x) => x.ok()];
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const p = uploadToR2('file://a.jpg', 'image/jpeg', 'stories');
    const settled = p.catch((e) => e);
    await vi.runAllTimersAsync();
    expect(String(await settled)).toMatch(/Network error/);
    expect(opened).toHaveLength(3); // 1 + 2 retries
  });

  it('fails a stalled attempt instead of hanging, then retries it', async () => {
    scripts = [() => undefined /* never answers, never progresses */, (x) => x.ok()];
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const p = uploadToR2('file://a.jpg', 'image/jpeg', 'stories', undefined, { stallTimeoutMs: 1_000 });
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe('https://cdn.test/stories/a.jpg');
    expect(opened[0].aborted).toBe(true);
  });

  it('progress keeps a slow but moving upload alive', async () => {
    scripts = [
      (x) => {
        let sent = 0;
        const tick = () => {
          sent += 10;
          x.upload.onprogress?.({ lengthComputable: true, loaded: sent, total: 100 });
          if (sent < 100) setTimeout(tick, 800);
          else x.ok();
        };
        tick();
      },
    ];
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const progress: number[] = [];
    const p = uploadToR2('file://a.jpg', 'image/jpeg', 'stories', (v) => progress.push(v), { stallTimeoutMs: 1_000 });
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBeTruthy();
    expect(opened).toHaveLength(1); // 8 s total, never 1 s without progress
    expect(progress.at(-1)).toBe(1);
  });

  it('cancelling aborts the request and is not retried', async () => {
    scripts = [() => undefined];
    const ac = new AbortController();
    const p = uploadToR2('file://a.jpg', 'image/jpeg', 'stories', undefined, { signal: ac.signal });
    await new Promise((r) => setTimeout(r, 5));
    ac.abort();
    const err = await p.catch((e) => e);
    expect(isUploadCancelled(err)).toBe(true);
    expect(opened).toHaveLength(1);
    expect(opened[0].aborted).toBe(true);
  });
});
