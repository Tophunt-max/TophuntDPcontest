/**
 * Story soundtracks.
 *
 * The editor already had a complete music picker — search field, results,
 * draggable now-playing sticker, play/pause — and none of it did anything:
 *
 *  1. the search was a direct `fetch` to `itunes.apple.com` from the browser, and
 *     the site's CSP `connect-src` does not list that host, so on the web every
 *     request was blocked before it left the page. The client logged it to the
 *     console and left the list empty.
 *  2. `createStory` accepted no music at all, so even a successful pick was
 *     dropped when the story was saved.
 *
 * The properties pinned below are the ones that fail SILENTLY — a story that
 * publishes without its soundtrack looks like a successful upload:
 *
 *  - the track has to actually land on the row;
 *  - a provider outage must not fail the upload, and must be DISTINGUISHABLE from
 *    "no music was chosen", or the client cannot tell the user their soundtrack
 *    was lost;
 *  - the client must not be able to choose what URL gets stored, because that URL
 *    is loaded by every viewer's browser;
 *  - a track with no preview stream must never be offered, since tapping it would
 *    play nothing.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('../src/lib/firebaseAuth', () => ({
  verifyIdToken: async (token: string) => {
    const [uid, role] = token.split(':');
    return { uid, role: role || 'user' };
  },
  bearerToken: (h?: string | null) => (h && h.startsWith('Bearer ') ? h.slice(7) : null),
}));

vi.mock('../src/lib/voteCounter', () => ({
  castVote: async () => ({ votesA: 0, votesB: 0, total: 0, alreadyVoted: false, deviceUsed: false, votingClosed: false }),
  bumpEngagement: async () => ({ like: 0, comment: 0, share: 0 }),
  getLiveTally: async () => ({ votesA: 0, votesB: 0, total: 0 }),
  getViewerVote: async () => ({ hasVoted: false, votedForUid: null }),
}));

import { makeEnv, makeApp, fakeCtx, drizzleOf, type TestEnv } from './helpers/harness';
import * as schema from '../src/db/schema';
import { normalizeTrack, sanitiseMusicStartMs } from '../src/lib/music';

const app = makeApp();
let env: TestEnv;

/** One Apple search/lookup row, as the provider actually shapes it. */
const providerRow = (over: Record<string, any> = {}) => ({
  trackId: 1440857781,
  trackName: 'Bohemian Rhapsody',
  artistName: 'Queen',
  artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/abc/100x100bb.jpg',
  previewUrl: 'https://audio-ssl.itunes.apple.com/itunes-assets/mzaf_123.m4a',
  ...over,
});

/** Stub global fetch with a queue of responses, and record the URLs requested. */
function stubFetch(responses: Array<{ ok?: boolean; body?: any } | Error>) {
  const calls: string[] = [];
  const queue = [...responses];
  const impl = vi.fn(async (input: any) => {
    calls.push(String(input));
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    if (next instanceof Error) throw next;
    return {
      ok: next?.ok !== false,
      async json() {
        return next?.body;
      },
    } as any;
  });
  (globalThis as any).fetch = impl;
  return { calls, impl };
}

const realFetch = globalThis.fetch;

async function call(uid: string, action: string, data: any = {}) {
  const res = await app.request(
    '/api',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${uid}` },
      body: JSON.stringify({ action, ...data }),
    },
    env,
    fakeCtx(),
  );
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

async function read(uid: string | null, path: string) {
  const res = await app.request(
    `/read${path}`,
    { headers: uid ? { Authorization: `Bearer ${uid}` } : {} },
    env,
    fakeCtx(),
  );
  return { status: res.status, body: (await res.json().catch(() => null)) as any, headers: res.headers };
}

beforeEach(async () => {
  ({ env } = makeEnv());
  const ts = Date.now();
  await drizzleOf(env)
    .insert(schema.users)
    .values({ uid: 'poster', username: 'poster', fullName: 'Poster', dpcoin: 0, createdAt: ts, updatedAt: ts } as any);
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const storyRows = () => drizzleOf(env).select().from(schema.stories).all();

/**
 * A query that cannot match the curated catalogue, so the PROVIDER fallback is
 * what gets exercised. The catalogue ships seeded by migration 0036 and the test
 * harness applies every migration — so a short query like "x" now matches real
 * curated rows and never reaches the provider at all.
 */
const MISS = 'zzq-no-such-track-zzq';

// --- the track lands on the story ------------------------------------------
describe('createStory with a soundtrack', () => {
  it('resolves the track and stores it on the row', async () => {
    stubFetch([{ body: { results: [providerRow()] } }]);

    const res = await call('poster', 'createStory', {
      mediaUrl: 'https://media.test/a.jpg',
      mediaType: 'photo',
      musicTrackId: '1440857781',
    });

    expect(res.status).toBe(200);
    expect(res.body.musicAttached).toBe(true);
    const rows = await storyRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      musicTrackId: '1440857781',
      musicTitle: 'Bohemian Rhapsody',
      musicArtist: 'Queen',
      musicPreviewUrl: 'https://audio-ssl.itunes.apple.com/itunes-assets/mzaf_123.m4a',
    });
  });

  it('stores nothing musical when no track was chosen, and says so', async () => {
    const { impl } = stubFetch([{ body: { results: [] } }]);

    const res = await call('poster', 'createStory', { mediaUrl: 'https://media.test/a.jpg' });

    expect(res.body.musicAttached).toBe(false);
    // No track id means no reason to talk to the provider at all.
    expect(impl).not.toHaveBeenCalled();
    const rows = await storyRows();
    expect(rows[0].musicTrackId).toBeNull();
    expect(rows[0].musicPreviewUrl).toBeNull();
  });

  it('still publishes the story when the provider is down, and reports the loss', async () => {
    // The user has already waited through a media upload. Failing the whole
    // story over a soundtrack would be the wrong trade — but silently claiming
    // success would leave them thinking the music saved.
    stubFetch([new Error('provider unreachable')]);

    const res = await call('poster', 'createStory', {
      mediaUrl: 'https://media.test/a.jpg',
      musicTrackId: '1440857781',
    });

    expect(res.status).toBe(200);
    expect(res.body.storyId).toBeTruthy();
    expect(res.body.musicAttached).toBe(false);
    expect((await storyRows())[0].musicPreviewUrl).toBeNull();
  });

  it('ignores a track id the provider does not know', async () => {
    stubFetch([{ body: { results: [] } }]);
    const res = await call('poster', 'createStory', {
      mediaUrl: 'https://media.test/a.jpg',
      musicTrackId: '999999999',
    });
    expect(res.body.musicAttached).toBe(false);
    expect((await storyRows())[0].musicTitle).toBeNull();
  });
});

// --- the client cannot choose the stored URL --------------------------------
describe('music fields are never taken from the client', () => {
  it('ignores client-supplied title, artist, artwork and preview URL', async () => {
    // A client-supplied preview URL would be loaded by every viewer's browser —
    // a way to log the IP and user-agent of everyone who watches the story, from
    // a domain they trust. Only the id is honoured; everything else is resolved.
    stubFetch([{ body: { results: [providerRow()] } }]);

    await call('poster', 'createStory', {
      mediaUrl: 'https://media.test/a.jpg',
      musicTrackId: '1440857781',
      musicPreviewUrl: 'https://evil.example/track-who-watched.m4a',
      musicArtworkUrl: 'https://evil.example/pixel.png',
      musicTitle: 'spoofed',
      musicArtist: 'spoofed',
    });

    const row = (await storyRows())[0];
    expect(row.musicPreviewUrl).toBe('https://audio-ssl.itunes.apple.com/itunes-assets/mzaf_123.m4a');
    expect(row.musicArtworkUrl).not.toContain('evil.example');
    expect(row.musicTitle).toBe('Bohemian Rhapsody');
    expect(row.musicArtist).toBe('Queen');
  });

  it('never interpolates a non-numeric track id into the outbound request', async () => {
    const { impl } = stubFetch([{ body: { results: [providerRow()] } }]);

    await call('poster', 'createStory', {
      mediaUrl: 'https://media.test/a.jpg',
      musicTrackId: '1&entity=../../evil',
    });

    // Rejected before any request is made, so nothing user-controlled reaches
    // the provider URL.
    expect(impl).not.toHaveBeenCalled();
    expect((await storyRows())[0].musicTrackId).toBeNull();
  });
});

// --- the story read path carries it ----------------------------------------
describe('the story reel', () => {
  it('returns the saved track to the viewer', async () => {
    stubFetch([{ body: { results: [providerRow()] } }]);
    await call('poster', 'createStory', {
      mediaUrl: 'https://media.test/a.jpg',
      musicTrackId: '1440857781',
      visibility: 'public',
    });

    const res = await read('poster', '/stories/feed');
    expect(res.status).toBe(200);
    const mine = res.body.find((u: any) => u.userId === 'poster');
    expect(mine.stories[0]).toMatchObject({
      musicTitle: 'Bohemian Rhapsody',
      musicPreviewUrl: 'https://audio-ssl.itunes.apple.com/itunes-assets/mzaf_123.m4a',
    });
  });
});

// --- search ----------------------------------------------------------------
describe('GET /read/music/search', () => {
  it('returns normalised tracks for a signed-in user', async () => {
    stubFetch([{ body: { results: [providerRow(), providerRow({ trackId: 2, trackName: 'Another' })] } }]);

    const res = await read('poster', '/music/search?q=queen');

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0]).toEqual({
      id: '1440857781',
      title: 'Bohemian Rhapsody',
      artist: 'Queen',
      // Upgraded from the 100px thumbnail the provider returns.
      artworkUrl: 'https://is1-ssl.mzstatic.com/image/thumb/abc/300x300bb.jpg',
      previewUrl: 'https://audio-ssl.itunes.apple.com/itunes-assets/mzaf_123.m4a',
    });
  });

  it('requires authentication, so it is not an open proxy on our domain', async () => {
    stubFetch([{ body: { results: [providerRow()] } }]);
    const res = await read(null, '/music/search?q=queen');
    expect(res.status).toBe(401);
  });

  it('drops tracks with no preview stream instead of offering silence', async () => {
    stubFetch([
      { body: { results: [providerRow({ trackId: 1, previewUrl: undefined }), providerRow({ trackId: 2 })] } },
    ]);
    const res = await read('poster', `/music/search?q=${MISS}`);
    expect(res.body.items.map((t: any) => t.id)).toEqual(['2']);
  });

  it('returns an empty list — not an error — when the provider is unreachable', async () => {
    // A failed search has to degrade the picker, not break the editor.
    stubFetch([new Error('offline')]);
    const res = await read('poster', `/music/search?q=${MISS}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    // …but it must SAY so. An empty array alone is what made a throttled provider
    // indistinguishable from "no such song" — the bug that left the picker blank.
    expect(res.body.providerFailed).toBe(true);
    expect(res.body.source).toBe('none');
  });

  it('does not call the provider for an empty query', async () => {
    const { impl } = stubFetch([{ body: { results: [] } }]);
    const res = await read('poster', '/music/search?q=');
    expect(res.body.items).toEqual([]);
    expect(impl).not.toHaveBeenCalled();
  });

  it('caches a result, so the default query is not one request per user', async () => {
    const { impl } = stubFetch([{ body: { results: [providerRow()] } }]);
    await read('poster', '/music/search?q=Top%20Hits');
    await read('poster', '/music/search?q=top hits');
    // Same query, normalised — one outbound call.
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it('does not cache an empty result, so an outage is not pinned for hours', async () => {
    const { impl } = stubFetch([new Error('down'), { body: { results: [providerRow()] } }]);
    expect((await read('poster', '/music/search?q=recover')).body.items).toEqual([]);
    expect((await read('poster', '/music/search?q=recover')).body.items).toHaveLength(1);
    expect(impl).toHaveBeenCalledTimes(2);
  });
});

// --- normalisation ---------------------------------------------------------
describe('normalizeTrack', () => {
  it('drops a row with no preview or no id', () => {
    expect(normalizeTrack(providerRow({ previewUrl: undefined }))).toBeNull();
    expect(normalizeTrack(providerRow({ previewUrl: '' }))).toBeNull();
    expect(normalizeTrack(providerRow({ trackId: undefined }))).toBeNull();
  });

  it('tolerates missing names rather than rendering "undefined"', () => {
    const t = normalizeTrack(providerRow({ trackName: undefined, artistName: undefined }));
    expect(t).toMatchObject({ title: 'Unknown track', artist: 'Unknown artist' });
  });

  it('leaves an artwork URL alone when it does not match the known scheme', () => {
    const t = normalizeTrack(providerRow({ artworkUrl100: 'https://cdn.test/cover.jpg' }));
    expect(t?.artworkUrl).toBe('https://cdn.test/cover.jpg');
  });

  it('returns null artwork rather than an empty string when there is none', () => {
    expect(normalizeTrack(providerRow({ artworkUrl100: undefined }))?.artworkUrl).toBeNull();
  });
});


// --- the curated catalogue -------------------------------------------------
/**
 * The catalogue is the fix for the picker being permanently empty.
 *
 * The first version asked Apple's iTunes Search API for "Top Hits" every time the
 * sheet opened. That works from a laptop and returns NOTHING from the deployed
 * Worker: the API throttles per source IP and a Worker's egress address is shared
 * with a very large amount of other traffic, so it answers "200 OK, zero results".
 * Because an empty result and a throttled request were the same response, the
 * sheet showed an empty state and there was no way to tell why.
 *
 * So the properties that matter are: the catalogue needs NO outbound request, it
 * is what search consults first, and a curated pick must attach to a story
 * without the provider being involved at all.
 */
describe('the curated music catalogue', () => {
  it('serves browsable categories without any outbound request', async () => {
    const { impl } = stubFetch([{ body: { results: [] } }]);

    const res = await read('poster', '/music/catalog');

    expect(res.status).toBe(200);
    expect(res.body.categories.length).toBeGreaterThan(0);
    // The entire point: nothing to rate-limit, nothing to be throttled.
    expect(impl).not.toHaveBeenCalled();
  });

  it('gives every category a label and at least one playable track', async () => {
    stubFetch([{ body: { results: [] } }]);
    const res = await read('poster', '/music/catalog');
    for (const cat of res.body.categories) {
      expect(cat.key).toBeTruthy();
      expect(cat.label).toBeTruthy();
      expect(cat.tracks.length).toBeGreaterThan(0);
      for (const t of cat.tracks) {
        // A track with no preview would be a row that plays nothing when tapped.
        expect(typeof t.previewUrl).toBe('string');
        expect(t.previewUrl.length).toBeGreaterThan(0);
        expect(t.title).toBeTruthy();
        expect(t.artist).toBeTruthy();
      }
    }
  });

  it('never lists the same track in two categories', async () => {
    stubFetch([{ body: { results: [] } }]);
    const res = await read('poster', '/music/catalog');
    const ids = res.body.categories.flatMap((c: any) => c.tracks.map((t: any) => t.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('requires authentication', async () => {
    stubFetch([{ body: { results: [] } }]);
    expect((await read(null, '/music/catalog')).status).toBe(401);
  });

  it('is searched BEFORE the provider, and answers without calling it', async () => {
    stubFetch([{ body: { results: [providerRow({ trackId: 999, trackName: 'from provider' })] } }]);

    // Pull a real curated title out of the catalogue and search for it.
    const catalog = await read('poster', '/music/catalog');
    const known = catalog.body.categories[0].tracks[0];
    const { impl } = stubFetch([{ body: { results: [] } }]);

    const res = await read('poster', `/music/search?q=${encodeURIComponent(known.artist)}`);

    expect(res.body.source).toBe('catalog');
    expect(res.body.items.length).toBeGreaterThan(0);
    expect(impl).not.toHaveBeenCalled();
  });

  it('attaches a curated track to a story with no provider call at all', async () => {
    const catalog = await read('poster', '/music/catalog');
    const known = catalog.body.categories[0].tracks[0];
    const { impl } = stubFetch([new Error('provider must not be needed')]);

    const res = await call('poster', 'createStory', {
      mediaUrl: 'https://media.test/a.jpg',
      musicTrackId: known.id,
    });

    // This is the path where a throttled provider used to publish a silent story.
    expect(res.body.musicAttached).toBe(true);
    expect(impl).not.toHaveBeenCalled();
    const row = (await storyRows())[0];
    expect(row.musicTitle).toBe(known.title);
    expect(row.musicPreviewUrl).toBe(known.previewUrl);
  });
});


// --- which part of the track plays (migration 0037) -------------------------
describe('sanitiseMusicStartMs', () => {
  it('keeps a sensible offset', () => {
    expect(sanitiseMusicStartMs(12_000)).toBe(12_000);
  });

  it('rounds to whole milliseconds', () => {
    expect(sanitiseMusicStartMs(12_000.6)).toBe(12_001);
  });

  it('treats the very beginning as "never set"', () => {
    // null, not 0, so the column keeps meaning the same thing it does for every
    // row that predates it.
    expect(sanitiseMusicStartMs(0)).toBeNull();
  });

  it('refuses a negative offset', () => {
    expect(sanitiseMusicStartMs(-4_000)).toBeNull();
  });

  it('refuses an offset at or past the end of a preview', () => {
    // Storing this would publish a story that plays silence, which is
    // indistinguishable from the music being broken.
    expect(sanitiseMusicStartMs(30_000)).toBeNull();
    expect(sanitiseMusicStartMs(45_000)).toBeNull();
  });

  it('accepts an offset just inside the preview', () => {
    expect(sanitiseMusicStartMs(29_999)).toBe(29_999);
  });

  it('handles junk without throwing', () => {
    expect(sanitiseMusicStartMs(undefined)).toBeNull();
    expect(sanitiseMusicStartMs(null)).toBeNull();
    expect(sanitiseMusicStartMs('nonsense')).toBeNull();
    expect(sanitiseMusicStartMs(NaN)).toBeNull();
    expect(sanitiseMusicStartMs(Infinity)).toBeNull();
    expect(sanitiseMusicStartMs({})).toBeNull();
  });

  it('accepts a numeric string, because JSON bodies are not typed', () => {
    expect(sanitiseMusicStartMs('12000')).toBe(12_000);
  });
});

describe('createStory stores the chosen start offset', () => {
  it('persists the offset alongside the track', async () => {
    stubFetch([{ body: { results: [providerRow()] } }]);

    const res = await call('poster', 'createStory', {
      mediaUrl: 'https://media.test/a.jpg',
      mediaType: 'photo',
      musicTrackId: '1440857781',
      musicStartMs: 12_000,
    });

    expect(res.status).toBe(200);
    expect((await storyRows())[0].musicStartMs).toBe(12_000);
  });

  it('defaults to null when the author never scrubbed', async () => {
    stubFetch([{ body: { results: [providerRow()] } }]);

    await call('poster', 'createStory', {
      mediaUrl: 'https://media.test/a.jpg',
      mediaType: 'photo',
      musicTrackId: '1440857781',
    });

    expect((await storyRows())[0].musicStartMs).toBeNull();
  });

  it('sanitises an out-of-range offset instead of storing silence', async () => {
    stubFetch([{ body: { results: [providerRow()] } }]);

    await call('poster', 'createStory', {
      mediaUrl: 'https://media.test/a.jpg',
      mediaType: 'photo',
      musicTrackId: '1440857781',
      musicStartMs: 999_999,
    });

    expect((await storyRows())[0].musicStartMs).toBeNull();
  });

  it('does not keep an offset when no track attached', async () => {
    // An offset that outlived the song it refers to would be meaningless.
    await call('poster', 'createStory', {
      mediaUrl: 'https://media.test/a.jpg',
      mediaType: 'photo',
      musicStartMs: 12_000,
    });

    const row = (await storyRows())[0];
    expect(row.musicTrackId).toBeNull();
    expect(row.musicStartMs).toBeNull();
  });

  it('drops the offset when the track lookup fails', async () => {
    // The story still publishes — just without music, so without a start either.
    stubFetch([{ body: { results: [] } }]);

    const res = await call('poster', 'createStory', {
      mediaUrl: 'https://media.test/a.jpg',
      mediaType: 'photo',
      musicTrackId: '9999999999',
      musicStartMs: 12_000,
    });

    expect(res.body.musicAttached).toBe(false);
    const row = (await storyRows())[0];
    expect(row.musicPreviewUrl).toBeNull();
    expect(row.musicStartMs).toBeNull();
  });
});
