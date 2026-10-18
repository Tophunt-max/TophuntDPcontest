/**
 * The share primitives that actually hand the VS image to the OS / browser.
 *
 * Pinned: a remote card is attached as a FILE (never passed as a URL to an API
 * that wants a local file), the caption travels with it where the platform
 * allows, a browser without file sharing is reported — not silently turned into a
 * link share — and Save image fetches the very same url.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  platform: { OS: 'web' as string },
  rnShare: vi.fn(),
  clipboard: vi.fn(async () => undefined),
  sharing: null as any,
  manipulate: vi.fn(),
}));

vi.mock('react-native', () => ({
  Platform: h.platform,
  Share: Object.assign((...a: any[]) => a, { share: h.rnShare, dismissedAction: 'dismissedAction', sharedAction: 'sharedAction' }),
  Linking: {},
}));
vi.mock('expo-clipboard', () => ({ setStringAsync: h.clipboard }));
vi.mock('expo-image-manipulator', () => ({ ImageManipulator: { manipulate: h.manipulate }, SaveFormat: { JPEG: 'jpeg' } }));
vi.mock('@/src/lib/vsNativeModules', () => ({ getSharing: () => h.sharing }));
vi.mock('@/src/services/api', () => ({ API_BASE_URL: 'https://api.test' }));

import { downloadBattleImage, shareBattleLink, shareImageFile, isCompletedShare } from '@/src/lib/share';

const CARD = 'https://media.tophunt.in/vs-cards/battles/m1-v1.jpg';
const caption = 'Best Smile — @alice vs @bob. Vote now on TopHunt 👇\nhttps://tophunt.in/battle/m1';
const url = 'https://tophunt.in/battle/m1';

const realFetch = globalThis.fetch;
let fetched: string[];
beforeEach(() => {
  fetched = [];
  h.rnShare.mockReset();
  h.clipboard.mockClear();
  h.manipulate.mockReset();
  h.sharing = null;
  globalThis.fetch = (async (u: any) => {
    fetched.push(String(u));
    return new Response(new Uint8Array([0xff, 0xd8, 0xff, 1]), { headers: { 'content-type': 'image/jpeg' } });
  }) as any;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete (globalThis as any).navigator;
  h.platform.OS = 'web';
});

function webNavigator(opts: { files: boolean; share?: any }) {
  const share = opts.share ?? vi.fn(async () => undefined);
  Object.defineProperty(globalThis, 'navigator', {
    value: { share, canShare: (d: any) => (d?.files ? opts.files : true) },
    configurable: true,
  });
  return share;
}

describe('shareImageFile — web', () => {
  it('attaches the composite FILE together with the caption', async () => {
    const share = webNavigator({ files: true });
    const out = await shareImageFile({ source: { kind: 'remote', url: CARD }, caption, url });
    expect(out).toBe('shared_image');
    expect(fetched).toEqual([CARD]);
    const arg = share.mock.calls[0][0];
    expect(arg.files).toHaveLength(1);
    expect(arg.files[0]).toBeInstanceOf(File);
    expect(arg.files[0].type).toBe('image/jpeg');
    expect(arg.text).toBe(caption);
  });

  it('reports image_unsupported instead of silently sending a link', async () => {
    const share = webNavigator({ files: false });
    expect(await shareImageFile({ source: { kind: 'remote', url: CARD }, caption, url })).toBe('image_unsupported');
    expect(share).not.toHaveBeenCalled();
  });

  it('a failed image fetch is a failure, not a success', async () => {
    webNavigator({ files: true });
    globalThis.fetch = (async () => new Response('nope', { status: 404 })) as any;
    const out = await shareImageFile({ source: { kind: 'remote', url: CARD }, caption, url });
    expect(out).toBe('failed');
    expect(isCompletedShare(out)).toBe(false);
  });

  it('a cancelled sheet is a dismissal', async () => {
    webNavigator({ files: true, share: vi.fn(async () => { throw Object.assign(new Error('x'), { name: 'AbortError' }); }) });
    expect(await shareImageFile({ source: { kind: 'remote', url: CARD }, caption, url })).toBe('dismissed');
  });

  it('a local capture (blob:) is shared as the file too', async () => {
    const share = webNavigator({ files: true });
    await shareImageFile({ source: { kind: 'local', uri: 'blob:https://tophunt.in/abc' }, caption, url });
    expect(fetched).toEqual(['blob:https://tophunt.in/abc']);
    expect(share.mock.calls[0][0].files).toHaveLength(1);
  });
});

describe('shareImageFile — native', () => {
  beforeEach(() => {
    h.manipulate.mockReturnValue({
      renderAsync: async () => ({ saveAsync: async () => ({ uri: 'file:///cache/card.jpg' }), release() {} }),
    });
  });

  it('iOS: sends the LOCAL file url and the caption in one share', async () => {
    h.platform.OS = 'ios';
    h.rnShare.mockResolvedValue({ action: 'sharedAction' });
    expect(await shareImageFile({ source: { kind: 'remote', url: CARD }, caption, url })).toBe('shared_image');
    expect(h.manipulate).toHaveBeenCalledWith(CARD);
    expect(h.rnShare).toHaveBeenCalledWith({ url: 'file:///cache/card.jpg', message: caption });
  });

  it('Android: shares the local file and copies the caption (no text on file intents)', async () => {
    h.platform.OS = 'android';
    const shareAsync = vi.fn(async (..._args: any[]) => undefined);
    h.sharing = { isAvailableAsync: async () => true, shareAsync };
    expect(await shareImageFile({ source: { kind: 'remote', url: CARD }, caption, url })).toBe('shared_image_caption_copied');
    expect(shareAsync.mock.calls[0][0]).toBe('file:///cache/card.jpg');
    expect(h.clipboard).toHaveBeenCalledWith(caption);
  });

  it('a capture is used as-is, never re-downloaded', async () => {
    h.platform.OS = 'android';
    const shareAsync = vi.fn(async (..._args: any[]) => undefined);
    h.sharing = { shareAsync };
    await shareImageFile({ source: { kind: 'local', uri: 'file:///tmp/capture.jpg' }, caption, url });
    expect(h.manipulate).not.toHaveBeenCalled();
    expect(shareAsync.mock.calls[0][0]).toBe('file:///tmp/capture.jpg');
  });

  it('cannot materialise the image -> failed (no fallback to a link or a photo)', async () => {
    h.platform.OS = 'ios';
    h.manipulate.mockReturnValue({ renderAsync: async () => { throw new Error('decode'); } });
    expect(await shareImageFile({ source: { kind: 'remote', url: CARD }, caption, url })).toBe('failed');
    expect(h.rnShare).not.toHaveBeenCalled();
  });

  it('a build without expo-sharing reports image_unsupported on Android', async () => {
    h.platform.OS = 'android';
    h.sharing = null;
    expect(await shareImageFile({ source: { kind: 'remote', url: CARD }, caption, url })).toBe('image_unsupported');
  });
});

describe('shareBattleLink', () => {
  it('web: link via Web Share, else clipboard — reported as a LINK', async () => {
    const share = webNavigator({ files: false });
    expect(await shareBattleLink({ caption, url })).toBe('shared_link');
    expect(share).toHaveBeenCalledWith({ text: caption, url });
    delete (globalThis as any).navigator;
    expect(await shareBattleLink({ caption, url })).toBe('copied_link');
    expect(h.clipboard).toHaveBeenCalledWith(caption);
  });

  it('native: text share, dismissal recognised', async () => {
    h.platform.OS = 'android';
    h.rnShare.mockResolvedValueOnce({ action: 'sharedAction' }).mockResolvedValueOnce({ action: 'dismissedAction' });
    expect(await shareBattleLink({ caption, url })).toBe('shared_link');
    expect(await shareBattleLink({ caption, url })).toBe('dismissed');
  });
});

describe('downloadBattleImage', () => {
  it('saves exactly the url that sharing attaches', async () => {
    const clicks: string[] = [];
    (globalThis as any).document = {
      createElement: () => ({ set href(v: string) { clicks.push(v); }, click() {}, remove() {} }),
      body: { appendChild() {} },
    };
    (globalThis as any).URL.createObjectURL = () => 'blob:saved';
    (globalThis as any).URL.revokeObjectURL = () => undefined;
    expect(await downloadBattleImage(CARD)).toBe(true);
    expect(fetched).toEqual([CARD]);
    delete (globalThis as any).document;
  });

  it('refuses to "save" when there is no image', async () => {
    expect(await downloadBattleImage(null)).toBe(false);
  });
});
