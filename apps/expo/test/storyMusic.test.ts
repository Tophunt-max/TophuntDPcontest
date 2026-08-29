/**
 * Story soundtracks, client side.
 *
 * The editor shipped with a complete-looking music picker that could never work:
 *
 *  1. it called `https://itunes.apple.com/search` DIRECTLY from the client. The
 *     site's CSP `connect-src` does not list that host, so on the web the browser
 *     blocked every request before it left the page — and the failure was caught
 *     into a bare `console.error`, so the list simply stayed empty. A blocked
 *     request, a provider outage and an obscure search term all rendered as the
 *     same "No music found".
 *  2. `createStoryRecord` had no music parameter at all, so even a track that was
 *     picked, previewed and shown on a sticker was DROPPED when the story was
 *     saved. The upload succeeded, so nothing looked wrong.
 *
 * These pin the two halves of the contract that make it work — and, more
 * importantly, the two failures that used to be invisible: a search that cannot
 * reach the server must be distinguishable from an empty result, and a track that
 * did not attach must be reported rather than silently publishing a silent story.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const readApi = vi.fn(async () => ({ items: [] }) as any);
const callApi = vi.fn(async () => ({ success: true, storyId: 's1', musicAttached: true }) as any);

vi.mock('@/src/services/api', () => ({
  callApi: (...a: any[]) => (callApi as any)(...a),
  readApi: (...a: any[]) => (readApi as any)(...a),
}));
vi.mock('@/src/services/firebase/initFirebase', () => ({
  auth: { currentUser: { uid: 'me' } },
}));
// storyService imports offlineStoryService, which pulls in the native SQLite
// adapter and two Flow-typed React Native modules at import time — none of which
// plain Node can parse. Same stubs as test/storyCache.test.ts; nothing under test
// here touches the offline cache.
vi.mock('@/src/database', () => ({
  database: {},
  StoryModel: class {},
  UserStoryModel: class {},
  PendingActionModel: class {},
}));
vi.mock('@react-native-community/netinfo', () => ({
  default: { fetch: async () => ({ isConnected: true }) },
}));
vi.mock('@nozbe/watermelondb', () => ({ Q: {}, Model: class {} }));

const track = (over: Record<string, any> = {}) => ({
  id: '1440857781',
  title: 'Bohemian Rhapsody',
  artist: 'Queen',
  artworkUrl: 'https://is1-ssl.mzstatic.com/image/thumb/abc/300x300bb.jpg',
  previewUrl: 'https://audio-ssl.itunes.apple.com/itunes-assets/mzaf_123.m4a',
  ...over,
});

beforeEach(() => {
  readApi.mockReset().mockResolvedValue({ items: [] });
  callApi.mockReset().mockResolvedValue({ success: true, storyId: 's1', musicAttached: true });
});

describe('searchMusic', () => {
  it('goes through our own Worker, not the provider', async () => {
    // The whole reason the feature was dead on the web: api.tophunt.in is an
    // allowed CSP origin, itunes.apple.com is not.
    readApi.mockResolvedValueOnce({ items: [track()] });
    const { searchMusic } = await import('@/src/services/stories/musicService');

    await searchMusic('queen');

    const [path, params] = readApi.mock.calls[0] as any[];
    expect(path).toBe('/read/music/search');
    expect(params).toMatchObject({ q: 'queen' });
    // Nothing here may name the provider — that is the Worker's business.
    expect(String(path)).not.toContain('itunes');
  });

  it('returns the tracks it was given', async () => {
    readApi.mockResolvedValueOnce({ items: [track(), track({ id: '2', title: 'Another' })] });
    const { searchMusic } = await import('@/src/services/stories/musicService');
    const out = await searchMusic('queen');
    expect(out.map((t) => t.id)).toEqual(['1440857781', '2']);
  });

  it('THROWS when the request fails, instead of looking like "no results"', async () => {
    // The old code caught this into console.error and returned nothing, which is
    // why a CSP block was indistinguishable from an obscure search term.
    readApi.mockRejectedValueOnce(new Error('Failed to fetch'));
    const { searchMusic } = await import('@/src/services/stories/musicService');
    await expect(searchMusic('queen')).rejects.toThrow(/failed to fetch/i);
  });

  it('does not call the server for an empty query', async () => {
    const { searchMusic } = await import('@/src/services/stories/musicService');
    expect(await searchMusic('   ')).toEqual([]);
    expect(readApi).not.toHaveBeenCalled();
  });

  it('drops a track with no preview stream', async () => {
    // Offering one would give the user a row that plays nothing when tapped.
    readApi.mockResolvedValueOnce({ items: [track({ id: 'a', previewUrl: '' }), track({ id: 'b' })] });
    const { searchMusic } = await import('@/src/services/stories/musicService');
    expect((await searchMusic('x')).map((t) => t.id)).toEqual(['b']);
  });

  it('tolerates a malformed body rather than throwing on `.filter`', async () => {
    readApi.mockResolvedValueOnce({} as any);
    const { searchMusic } = await import('@/src/services/stories/musicService');
    expect(await searchMusic('x')).toEqual([]);
  });
});

describe('createStoryRecord with music', () => {
  it('sends ONLY the track id', async () => {
    const { createStoryRecord } = await import('@/src/services/stories/storyService');

    await createStoryRecord('https://media.test/a.jpg', 'image', 'public', null, null, [], '1440857781');

    const [action, payload] = callApi.mock.calls[0] as any[];
    expect(action).toBe('createStory');
    expect(payload.musicTrackId).toBe('1440857781');
    // A client-supplied preview URL would be loaded by every viewer's browser.
    // The server resolves these; sending them would be the vulnerability.
    expect(payload.musicPreviewUrl).toBeUndefined();
    expect(payload.musicTitle).toBeUndefined();
    expect(payload.musicArtworkUrl).toBeUndefined();
  });

  it('omits the field entirely when no track was chosen', async () => {
    const { createStoryRecord } = await import('@/src/services/stories/storyService');
    await createStoryRecord('https://media.test/a.jpg', 'image', 'public', null, null, [], null);
    const [, payload] = callApi.mock.calls[0] as any[];
    expect(payload.musicTrackId).toBeUndefined();
  });

  it('reports back whether the track actually attached', async () => {
    // This is what lets the screen say "posted without music" instead of
    // publishing a silent story and claiming success.
    callApi.mockResolvedValueOnce({ success: true, storyId: 's9', musicAttached: false });
    const { createStoryRecord } = await import('@/src/services/stories/storyService');

    const res = await createStoryRecord('https://media.test/a.jpg', 'image', 'public', null, null, [], '123');

    expect(res).toEqual({ storyId: 's9', musicAttached: false });
  });

  it('treats a missing musicAttached from an older server as "not attached"', async () => {
    callApi.mockResolvedValueOnce({ success: true, storyId: 's9' });
    const { createStoryRecord } = await import('@/src/services/stories/storyService');
    expect((await createStoryRecord('u', 'image')).musicAttached).toBe(false);
  });

  it('still throws when the story itself fails', async () => {
    callApi.mockResolvedValueOnce({ success: false, message: 'nope' });
    const { createStoryRecord } = await import('@/src/services/stories/storyService');
    await expect(createStoryRecord('u', 'image')).rejects.toThrow('nope');
  });
});
