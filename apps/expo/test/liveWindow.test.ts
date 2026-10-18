/**
 * Home keeps live sockets only for visible cards plus one ahead (src/lib/liveWindow.ts).
 */
import { describe, it, expect } from 'vitest';
import { LIVE_AHEAD, LIVE_CATCH_UP_AFTER_MS, liveIdsFor, needsCatchUp, sameIds, shouldListen } from '@/src/lib/liveWindow';

const data = Array.from({ length: 20 }, (_, i) => ({ id: `m${i}` }));
const viewable = (...idx: number[]) => idx.map((i) => ({ index: i, item: data[i] }));

describe('live window', () => {
  it('is the visible cards plus the next one', () => {
    expect([...liveIdsFor(viewable(3, 4), data)]).toEqual(['m3', 'm4', 'm5']);
    expect(LIVE_AHEAD).toBe(1);
  });

  it('stays small however long the feed is', () => {
    const big = Array.from({ length: 500 }, (_, i) => ({ id: `b${i}` }));
    const ids = liveIdsFor([{ index: 250, item: big[250] }, { index: 251, item: big[251] }], big);
    expect(ids.size).toBe(3);
  });

  it('does not run past the end, and ignores skeleton rows', () => {
    expect([...liveIdsFor(viewable(19), data)]).toEqual(['m19']);
    expect(liveIdsFor([{ index: 0, item: 1 }, { index: 1, item: 2 }], [1, 2, 3]).size).toBe(0);
  });

  it('nothing visible → nothing live', () => {
    expect(liveIdsFor([], data).size).toBe(0);
  });

  it('sameIds lets Home skip re-renders when the window did not move', () => {
    expect(sameIds(new Set(['a', 'b']), new Set(['b', 'a']))).toBe(true);
    expect(sameIds(new Set(['a']), new Set(['a', 'b']))).toBe(false);
    expect(sameIds(new Set(['a', 'c']), new Set(['a', 'b']))).toBe(false);
  });
});

describe('when a card listens and catches up', () => {
  it('off-screen cards never listen', () => {
    expect(shouldListen({ liveActive: false, signedIn: true, status: 'active' })).toBe(false);
  });

  it('a guest listens only to live battles (the Worker refuses the rest)', () => {
    expect(shouldListen({ liveActive: true, signedIn: false, status: 'active' })).toBe(true);
    expect(shouldListen({ liveActive: true, signedIn: false, status: 'waiting_for_opponent' })).toBe(true);
    expect(shouldListen({ liveActive: true, signedIn: false, status: 'completed' })).toBe(false);
    expect(shouldListen({ liveActive: true, signedIn: false, status: 'cancelled' })).toBe(false);
  });

  it('a signed-in viewer keeps listening to finished battles (likes/comments still move)', () => {
    expect(shouldListen({ liveActive: true, signedIn: true, status: 'completed' })).toBe(true);
  });

  it('a card mounted off screen long ago catches up when it first becomes live', () => {
    const mountedAt = 1_000_000;
    expect(needsCatchUp(mountedAt, mountedAt + LIVE_CATCH_UP_AFTER_MS + 1)).toBe(true);
  });

  it('a quick scroll back does not cost a read; a card that just stopped listening is not stale', () => {
    expect(needsCatchUp(1_000_000, 1_000_000 + 5_000)).toBe(false);
    expect(needsCatchUp(null, 9_999_999)).toBe(false);
  });
});
