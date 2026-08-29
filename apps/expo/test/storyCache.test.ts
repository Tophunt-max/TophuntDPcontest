/**
 * The offline story cache must not lose what makes a story a BATTLE.
 *
 * The viewer decides to draw the merged head-to-head frame with `isVsStory`,
 * which needs BOTH `type: 'contest_vs'` and a `matchId`. Those two fields travel
 * from the server, get written into the local WatermelonDB cache, and are read
 * back on the next feed load — and `fetchStories` serves that cache BEFORE the
 * network, so the cached copy is what the viewer almost always sees.
 *
 * The bug this guards against: the cache serialization dropped `matchId` and
 * `type` (and `contestTitle`) on the way in, so a battle story came back from the
 * cache looking like an ordinary single-photo story. `isVsStory` then returned
 * false and the viewer rendered each participant's OWN entry instead of the
 * merged VS frame — "only the joiner's image shows". Nothing caught it because
 * the code compiled and ran; the story just quietly came back incomplete.
 *
 * So this test round-trips a Story through the exact two functions the cache uses
 * and asserts the battle survives. It stands in for a full WatermelonDB write,
 * which needs a native SQLite adapter this Node test does not have — the field
 * copy is the part that was wrong, and it is pure.
 */
import { describe, it, expect, vi } from 'vitest';

// Keep the native SQLite adapter (and Firebase) out of this Node test — we only
// want the pure serialization helpers from offlineStoryService.
vi.mock('@/src/database', () => ({ database: {}, StoryModel: class {}, UserStoryModel: class {}, PendingActionModel: class {} }));
vi.mock('@/src/services/firebase/initFirebase', () => ({ auth: { currentUser: null } }));
// Native, Flow-typed modules that offlineStoryService pulls in at import time and
// that plain Node cannot parse. None are exercised by the serialization helpers.
vi.mock('@react-native-community/netinfo', () => ({ default: { fetch: async () => ({ isConnected: false }) } }));
vi.mock('@nozbe/watermelondb', () => ({ Q: {}, Model: class {} }));

import { applyStoryFields, mapStoryModelToStory } from '@/src/services/stories/offlineStoryService';
import { isVsStory, type Story } from '@/src/types/stories';

/**
 * A stand-in for StoryModel: plain assignable fields plus the two JSON getters
 * the real model exposes, so `mapStoryModelToStory` behaves exactly as it does
 * against a persisted record.
 */
function fakeRecord(): any {
  return {
    getTextPosition() {
      return this.textPosition ? JSON.parse(this.textPosition) : null;
    },
    getMentions() {
      try {
        return this.mentions ? JSON.parse(this.mentions) : [];
      } catch {
        return [];
      }
    },
  };
}

/** Write a Story into a fake record, then read it back — what the cache does. */
function roundTrip(story: Story): Story {
  const record = fakeRecord();
  applyStoryFields(record, story);
  return mapStoryModelToStory(record);
}

const vsStory: Story = {
  id: 's1',
  userId: 'bob',
  username: 'bob',
  avatarUrl: 'bob-pfp.jpg',
  mediaUrl: 'bob-entry.jpg',
  mediaType: 'image',
  createdAt: 1_700_000_000_000,
  expiresAt: 1_700_086_400_000,
  seen: false,
  type: 'contest_vs',
  matchId: 'm42',
  contestTitle: 'Best Smile',
};

describe('story cache round-trip', () => {
  it('keeps a battle story a battle', () => {
    const out = roundTrip(vsStory);
    // The exact fields isVsStory depends on.
    expect(out.type).toBe('contest_vs');
    expect(out.matchId).toBe('m42');
    // The regression check, stated as the viewer sees it.
    expect(isVsStory(out)).toBe(true);
  });

  it('preserves the contest title used by the share text and frame header', () => {
    expect(roundTrip(vsStory).contestTitle).toBe('Best Smile');
  });

  it('preserves the retired contest_match_live alias too', () => {
    // Rows written before the rename still carry this, and isVsStory treats it as
    // an alias — so the cache must not turn it into a plain story either.
    const out = roundTrip({ ...vsStory, type: 'contest_match_live' });
    expect(out.type).toBe('contest_match_live');
    expect(isVsStory(out)).toBe(true);
  });

  it('leaves an ordinary user story with no battle fields', () => {
    const user: Story = {
      id: 's2',
      userId: 'alice',
      username: 'alice',
      avatarUrl: '',
      mediaUrl: 'a.jpg',
      mediaType: 'image',
      createdAt: 1,
      expiresAt: 2,
      seen: false,
      type: 'user',
    };
    const out = roundTrip(user);
    expect(out.matchId ?? null).toBeNull();
    expect(isVsStory(out)).toBe(false);
  });

  it('does not invent a matchId when the server sent none', () => {
    // A contest_announcement (waiting for a rival) has a type but its matchId can
    // be absent; the cache must round-trip that faithfully rather than coercing.
    const out = roundTrip({ ...vsStory, type: 'contest_announcement', matchId: null });
    expect(out.matchId ?? null).toBeNull();
    expect(isVsStory(out)).toBe(false); // no matchId → not yet a VS frame
  });

  it('still preserves the ordinary fields it always did', () => {
    const out = roundTrip(vsStory);
    expect(out.mediaUrl).toBe('bob-entry.jpg');
    expect(out.mediaType).toBe('image');
    expect(out.username).toBe('bob');
    expect(out.createdAt).toBe(1_700_000_000_000);
  });
});


/**
 * The same failure mode as the battle fields above, one feature later.
 *
 * A story published with a soundtrack neither played nor showed its music pill.
 * The server resolves title/artist/artwork/preview from the track id the client
 * sends and returns them in the feed, but the cache wrote none of them — and the
 * cache is what the viewer reads. `musicPreviewUrl` is the value the viewer gates
 * on twice: it is the audio player's source AND the condition for rendering the
 * pill, so dropping it silenced the track and hid the label in one go.
 *
 * These fields are optional on `Story`, so the omission type-checked — which is
 * exactly why it needs a test rather than a compiler.
 */
describe('offline story cache — soundtrack', () => {
  const musicStory: Story = {
    id: 's3',
    userId: 'carol',
    username: 'carol',
    avatarUrl: '',
    mediaUrl: 'carol.jpg',
    mediaType: 'image',
    createdAt: 1_700_000_000_000,
    expiresAt: 1_700_086_400_000,
    seen: false,
    type: 'user',
    musicTrackId: 't-99',
    musicTitle: 'Sunflower',
    musicArtist: 'Post Malone',
    musicArtworkUrl: 'https://cdn.example/art.jpg',
    musicPreviewUrl: 'https://cdn.example/preview.mp3',
  };

  it('round-trips every music field through the cache', () => {
    const out = roundTrip(musicStory);
    expect(out.musicTrackId).toBe('t-99');
    expect(out.musicTitle).toBe('Sunflower');
    expect(out.musicArtist).toBe('Post Malone');
    expect(out.musicArtworkUrl).toBe('https://cdn.example/art.jpg');
    expect(out.musicPreviewUrl).toBe('https://cdn.example/preview.mp3');
  });

  it('keeps the preview url the viewer gates the player and pill on', () => {
    // Guarded on its own: this single field decides both whether audio plays and
    // whether the pill renders, so losing it is what made music look absent.
    expect(roundTrip(musicStory).musicPreviewUrl).toBeTruthy();
  });

  it('persists music onto the record, not just into the returned object', () => {
    // Asserts the WRITE half. A mapper that read the fields back off the input
    // story rather than the record would pass the round-trip test above while
    // still writing nothing to WatermelonDB.
    const record = fakeRecord();
    applyStoryFields(record, musicStory);
    expect(record.musicPreviewUrl).toBe('https://cdn.example/preview.mp3');
    expect(record.musicTitle).toBe('Sunflower');
    expect(record.musicTrackId).toBe('t-99');
  });

  it('leaves a story with no music with null music fields', () => {
    const out = roundTrip({ ...musicStory, musicTrackId: undefined, musicTitle: undefined, musicArtist: undefined, musicArtworkUrl: undefined, musicPreviewUrl: undefined });
    expect(out.musicPreviewUrl ?? null).toBeNull();
    expect(out.musicTitle ?? null).toBeNull();
  });

  it('does not write undefined-as-null into non-null local columns', () => {
    // The local columns are optional; `?? undefined` (not `?? null`) is what keeps
    // a null from the API out of them, matching how matchId/type are handled.
    const record = fakeRecord();
    applyStoryFields(record, { ...musicStory, musicPreviewUrl: null as any, musicTitle: null as any });
    expect(record.musicPreviewUrl).toBeUndefined();
    expect(record.musicTitle).toBeUndefined();
  });

  it('still preserves music alongside the battle fields', () => {
    // A contest story can carry a soundtrack too — the two feature sets must not
    // clobber each other in the shared serializer.
    const out = roundTrip({ ...musicStory, type: 'contest_vs', matchId: 'm7', contestTitle: 'Best Smile' });
    expect(isVsStory(out)).toBe(true);
    expect(out.musicPreviewUrl).toBe('https://cdn.example/preview.mp3');
    expect(out.contestTitle).toBe('Best Smile');
  });
});


/**
 * The trim offset has to survive the cache too (schema v4).
 *
 * Its failure mode is quieter than the rest of the music fields: losing it does
 * not silence the story, it resets every cached story to 0:00. The music still
 * plays, so the loss looks like the trim feature never worked rather than like a
 * cache bug — which is precisely why it needs pinning here.
 */
describe('offline story cache — music start offset', () => {
  const trimmed: Story = {
    id: 's4',
    userId: 'dan',
    username: 'dan',
    avatarUrl: '',
    mediaUrl: 'dan.jpg',
    mediaType: 'image',
    createdAt: 1_700_000_000_000,
    expiresAt: 1_700_086_400_000,
    seen: false,
    type: 'user',
    musicTrackId: 't-7',
    musicTitle: 'Husn',
    musicArtist: 'Anuv Jain',
    musicPreviewUrl: 'https://cdn.example/husn.m4a',
    musicStartMs: 12_000,
  };

  it('round-trips the offset', () => {
    expect(roundTrip(trimmed).musicStartMs).toBe(12_000);
  });

  it('persists it onto the record, not just the returned object', () => {
    const record = fakeRecord();
    applyStoryFields(record, trimmed);
    expect(record.musicStartMs).toBe(12_000);
  });

  it('keeps 0:00 as null rather than inventing an offset', () => {
    expect(roundTrip({ ...trimmed, musicStartMs: undefined }).musicStartMs ?? null).toBeNull();
    expect(roundTrip({ ...trimmed, musicStartMs: null }).musicStartMs ?? null).toBeNull();
  });

  it('does not write null into the optional local column', () => {
    const record = fakeRecord();
    applyStoryFields(record, { ...trimmed, musicStartMs: null });
    expect(record.musicStartMs).toBeUndefined();
  });

  it('keeps the offset alongside the rest of the soundtrack', () => {
    const out = roundTrip(trimmed);
    expect(out.musicPreviewUrl).toBe('https://cdn.example/husn.m4a');
    expect(out.musicTitle).toBe('Husn');
    expect(out.musicStartMs).toBe(12_000);
  });
});
