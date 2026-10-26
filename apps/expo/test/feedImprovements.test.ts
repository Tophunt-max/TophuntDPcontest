/**
 * Home feed follow-ups: "Not interested" undo (src/lib/feedUndo.ts) and the
 * remembered list and scroll position (src/lib/feedSession.ts).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { removeCard, restoreCard } from '@/src/lib/feedUndo';
import {
  MAX_AGE_MS,
  MAX_RESTORE_RENDER,
  clearFeedSessions,
  restoreRenderCount,
  saveFeedSession,
  takeFeedSession,
} from '@/src/lib/feedSession';

const ids = (xs: any[]) => xs.map((x) => x.id);
const list = ['a', 'b', 'c', 'd'].map((id) => ({ id }));

describe('Not interested undo', () => {
  it('removes a card and puts it back in the same place', () => {
    const { list: without, removed } = removeCard(list, 'c');
    expect(ids(without)).toEqual(['a', 'b', 'd']);
    expect(removed).toEqual({ item: { id: 'c' }, index: 2 });
    expect(ids(restoreCard(without, removed!))).toEqual(['a', 'b', 'c', 'd']);
  });
  it('clamps to the end if the list got shorter, and never duplicates', () => {
    const { removed } = removeCard(list, 'd');
    expect(ids(restoreCard([{ id: 'a' }], removed!))).toEqual(['a', 'd']);
    expect(ids(restoreCard(list, removed!))).toEqual(['a', 'b', 'c', 'd']);
  });
  it('an id that is not in the list changes nothing', () => {
    const r = removeCard(list, 'zz');
    expect(r.list).toBe(list);
    expect(r.removed).toBeNull();
  });
});

describe('Home scroll restore', () => {
  beforeEach(() => clearFeedSessions());

  it('gives back the list, cursor and position once', () => {
    saveFeedSession('u1|foryou', { items: list, nextCursor: 'f2.x.AAAA', offset: 1234, firstIndex: 2 }, 1000);
    const s = takeFeedSession('u1|foryou', 2000);
    expect(s).toMatchObject({ items: list, nextCursor: 'f2.x.AAAA', offset: 1234, firstIndex: 2 });
    expect(takeFeedSession('u1|foryou', 2000)).toBeNull();
  });
  it('forgets positions older than the limit, and empty lists', () => {
    saveFeedSession('u1|foryou', { items: list, nextCursor: null, offset: 10, firstIndex: 0 }, 0);
    expect(takeFeedSession('u1|foryou', MAX_AGE_MS + 1)).toBeNull();
    saveFeedSession('u1|foryou', { items: [], nextCursor: null, offset: 10, firstIndex: 0 }, 0);
    expect(takeFeedSession('u1|foryou', 1)).toBeNull();
  });
  it('is per account and tab, and sign-out clears it', () => {
    saveFeedSession('u1|foryou', { items: list, nextCursor: null, offset: 1, firstIndex: 0 }, 0);
    saveFeedSession('u2|foryou', { items: list, nextCursor: null, offset: 2, firstIndex: 0 }, 0);
    expect(takeFeedSession('u1|following', 1)).toBeNull();
    clearFeedSessions('u1');
    expect(takeFeedSession('u1|foryou', 1)).toBeNull();
    expect(takeFeedSession('u2|foryou', 1)?.offset).toBe(2);
    saveFeedSession('u2|foryou', { items: list, nextCursor: null, offset: 2, firstIndex: 0 }, 0);
    clearFeedSessions();
    expect(takeFeedSession('u2|foryou', 1)).toBeNull();
  });
  it('renders enough cards to reach the saved position, within a bound', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ id: `m${i}` }));
    expect(restoreRenderCount(null, 4)).toBe(4);
    expect(restoreRenderCount({ items: many, nextCursor: null, offset: 0, firstIndex: 5, savedAt: 0 }, 4)).toBe(8);
    expect(restoreRenderCount({ items: many, nextCursor: null, offset: 0, firstIndex: 50, savedAt: 0 }, 4)).toBe(MAX_RESTORE_RENDER);
  });
});
