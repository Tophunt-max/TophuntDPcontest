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
