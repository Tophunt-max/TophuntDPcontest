/**
 * Local-first Home feed snapshot (src/lib/feedSnapshot.ts).
 *
 * Covers the cache policy Home relies on: cold vs warm start, expiry, viewer
 * isolation on account switch and logout, block/mute invalidation, bounded size,
 * no inline media bytes, page de-duplication, and failure of the local store
 * degrading to the network path instead of throwing.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// The module lazily imports the real database only from its default store; every
// test here swaps in an in-memory store, so the native adapter never loads.
vi.mock('@/src/database', () => ({ database: {} }));

import {
  __setSnapshotStoreForTests,
  appendPage,
  clearFeedSnapshots,
  feedOwnerKey,
  getFeedCacheStats,
  loadFeedSnapshot,
  loadOfflineFeed,
  MAX_RENDER_AGE_MS,
  MAX_SNAPSHOT_BYTES,
  MAX_SNAPSHOT_ITEMS,
  planFeedLoad,
  sanitizeFeedItems,
  saveFeedSnapshot,
  snapshotGeneration,
  SNAPSHOT_FORMAT,
  type FeedSnapshot,
  type SnapshotStore,
} from '@/src/lib/feedSnapshot';
import { bumpSocialGraphVersion } from '@/src/lib/socialGraphVersion';

/** In-memory stand-in with the same contract as the WatermelonDB store. */
function memoryStore() {
  const rows = new Map<string, FeedSnapshot>();
  const store: SnapshotStore & { rows: Map<string, FeedSnapshot> } = {
    rows,
    async read(id) {
      const r = rows.get(id);
      return r ? JSON.parse(JSON.stringify(r)) : null;
    },
    async write(id, snap) {
      for (const [k, v] of rows) if (v.owner !== snap.owner) rows.delete(k);
      rows.set(id, JSON.parse(JSON.stringify(snap)));
    },
    async remove(filter) {
      for (const [k, v] of rows) {
        if ((!filter?.owner || v.owner === filter.owner) && (!filter?.id || k === filter.id)) rows.delete(k);
      }
    },
  };
  return store;
}

const match = (id: string, extra: Record<string, any> = {}) => ({
  id,
  status: 'active',
  title: `Battle ${id}`,
  userA: { uid: 'a', username: 'a', mediaUrl: `https://cdn.example/${id}-a.jpg`, votes: 3 },
  userB: { uid: 'b', username: 'b', mediaUrl: `https://cdn.example/${id}-b.jpg`, votes: 1 },
  expiresAt: Date.now() + 3_600_000,
  ...extra,
});

/** Simulate an app restart: same disk, empty session memory. */
function restart(store: ReturnType<typeof memoryStore>) {
  __setSnapshotStoreForTests(store);
}

let store: ReturnType<typeof memoryStore>;
beforeEach(() => {
  store = memoryStore();
  __setSnapshotStoreForTests(store);
});

describe('cold and warm start', () => {
  it('cold start with no cache goes to the network', async () => {
    const snap = await loadFeedSnapshot(feedOwnerKey('alice'), 'foryou');
    expect(snap).toBeNull();
    expect(planFeedLoad(snap, feedOwnerKey('alice'))).toBe('network');
    expect(getFeedCacheStats().misses).toBe(1);
  });

  it('warm start after a restart paints the snapshot and revalidates', async () => {
    const owner = feedOwnerKey('alice');
    const t0 = Date.now() - 5 * 60_000; // fetched five minutes ago
    await saveFeedSnapshot(owner, 'foryou', [match('m1'), match('m2')], 8, t0);
    restart(store);

    const snap = await loadFeedSnapshot(owner, 'foryou');
    expect(snap?.items.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(planFeedLoad(snap, owner)).toBe('paint-revalidate');
    expect(getFeedCacheStats().diskHits).toBe(1);
  });

  it('a remount seconds later paints from session memory but STILL revalidates', async () => {
    // The viewer may have voted/liked since the save; PostCard holds that in its
    // own state, so trusting a seconds-old snapshot would repaint it as un-voted.
    const owner = feedOwnerKey('alice');
    await saveFeedSnapshot(owner, 'foryou', [match('m1')], 8);
    const snap = await loadFeedSnapshot(owner, 'foryou');
    expect(planFeedLoad(snap, owner)).toBe('paint-revalidate');
    expect(getFeedCacheStats().memoryHits).toBe(1);
  });

  it('round-trips string cursors as strings and numeric cursors as numbers', async () => {
    const owner = feedOwnerKey('alice');
    await saveFeedSnapshot(owner, 'foryou', [match('m1')], 16);
    await saveFeedSnapshot(owner, 'following', [match('m2')], 'opaque_1');
    restart(store);
    expect((await loadFeedSnapshot(owner, 'foryou'))?.nextCursor).toBe(16);
    expect((await loadFeedSnapshot(owner, 'following'))?.nextCursor).toBe('opaque_1');
  });
});

describe('expiry and format', () => {
  it('does not paint a snapshot older than the render ceiling', async () => {
    const owner = feedOwnerKey('alice');
    await saveFeedSnapshot(owner, 'foryou', [match('m1')], null, Date.now() - MAX_RENDER_AGE_MS - 1);
    restart(store);
    expect(await loadFeedSnapshot(owner, 'foryou')).toBeNull();
  });

  it('never plans to paint a snapshot from the future (clock skew) or of another owner', () => {
    const owner = feedOwnerKey('alice');
    const base: FeedSnapshot = { owner, tab: 'foryou', items: [match('m1')], nextCursor: null, fetchedAt: Date.now(), format: SNAPSHOT_FORMAT };
    expect(planFeedLoad({ ...base, fetchedAt: Date.now() + 60_000 }, owner)).toBe('network');
    expect(planFeedLoad(base, feedOwnerKey('bob'))).toBe('network');
  });

  it('ignores rows written in another payload format', async () => {
    const owner = feedOwnerKey('alice');
    store.rows.set(`${owner}|foryou`, {
      owner, tab: 'foryou', items: [match('m1')], nextCursor: null, fetchedAt: Date.now(), format: SNAPSHOT_FORMAT + 1,
    });
    expect(await loadFeedSnapshot(owner, 'foryou')).toBeNull();
  });

  it('an empty fresh answer forgets the old snapshot instead of resurrecting it', async () => {
    const owner = feedOwnerKey('alice');
    await saveFeedSnapshot(owner, 'following', [match('m1')], null);
    await saveFeedSnapshot(owner, 'following', [], null);
    restart(store);
    expect(await loadFeedSnapshot(owner, 'following')).toBeNull();
  });

  it('…but keeps it as an offline fallback for the same owner only', async () => {
    const owner = feedOwnerKey('alice');
    await saveFeedSnapshot(owner, 'following', [match('m1')], null);
    await saveFeedSnapshot(owner, 'following', [], null);
    restart(store);
    expect((await loadOfflineFeed(owner, 'following'))?.items.map((m) => m.id)).toEqual(['m1']);
    expect(await loadOfflineFeed(feedOwnerKey('bob'), 'following')).toBeNull();
    await clearFeedSnapshots();
    expect(await loadOfflineFeed(owner, 'following')).toBeNull();
  });

  it('shows a days-old snapshot, minus battles that ended over a day ago', async () => {
    const owner = feedOwnerKey('alice');
    const now = Date.now();
    const saved = now - 3 * 24 * 3600_000;
    await saveFeedSnapshot(owner, 'foryou', [
      match('old', { expiresAt: now - 2 * 24 * 3600_000 }),
      match('live', { expiresAt: now + 3600_000 }),
    ], null, saved);
    restart(store);
    expect((await loadFeedSnapshot(owner, 'foryou', now))?.items.map((m) => m.id)).toEqual(['live']);
    expect(MAX_RENDER_AGE_MS).toBe(7 * 24 * 3600_000);
  });
});

describe('viewer isolation', () => {
  it('For You and Following are separate entries', async () => {
    const owner = feedOwnerKey('alice');
    await saveFeedSnapshot(owner, 'foryou', [match('f1')], null);
    await saveFeedSnapshot(owner, 'following', [match('g1')], null);
    expect((await loadFeedSnapshot(owner, 'foryou'))?.items[0].id).toBe('f1');
    expect((await loadFeedSnapshot(owner, 'following'))?.items[0].id).toBe('g1');
  });

  it('account B never reads account A’s snapshot, in memory or on disk', async () => {
    await saveFeedSnapshot(feedOwnerKey('alice'), 'foryou', [match('m1', { hasVoted: true, isLiked: true })], null);
    expect(await loadFeedSnapshot(feedOwnerKey('bob'), 'foryou')).toBeNull();
    restart(store);
    expect(await loadFeedSnapshot(feedOwnerKey('bob'), 'foryou')).toBeNull();
  });

  it('a guest never reads a signed-in snapshot after logout', async () => {
    await saveFeedSnapshot(feedOwnerKey('alice'), 'foryou', [match('m1', { isBookmarked: true })], null);
    expect(await loadFeedSnapshot(feedOwnerKey(null), 'foryou')).toBeNull();
  });

  it('writing for one viewer deletes every other viewer’s rows (storage holds one owner)', async () => {
    await saveFeedSnapshot(feedOwnerKey('alice'), 'foryou', [match('m1')], null);
    await saveFeedSnapshot(feedOwnerKey('alice'), 'following', [match('m2')], null);
    await saveFeedSnapshot(feedOwnerKey('bob'), 'foryou', [match('m3')], null);
    expect([...store.rows.values()].map((r) => r.owner)).toEqual(['u:bob']);
  });

  it('clearFeedSnapshots (account change) wipes memory and disk', async () => {
    const owner = feedOwnerKey('alice');
    await saveFeedSnapshot(owner, 'foryou', [match('m1')], null);
    await clearFeedSnapshots();
    expect(store.rows.size).toBe(0);
    expect(await loadFeedSnapshot(owner, 'foryou')).toBeNull();
  });

  it('a response fetched before a block is not persisted after it', async () => {
    const owner = feedOwnerKey('alice');
    const gen = snapshotGeneration(); // fetch starts
    bumpSocialGraphVersion(); // user blocks someone while it is in flight
    await new Promise((r) => setTimeout(r, 0));
    await saveFeedSnapshot(owner, 'foryou', [match('from-blocked-creator')], null, Date.now(), gen);
    expect(store.rows.size).toBe(0);
    expect(await loadFeedSnapshot(owner, 'foryou')).toBeNull();
  });

  it('a clear that lands while a write is queued wins', async () => {
    const owner = feedOwnerKey('alice');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = memoryStore();
    const origWrite = slow.write;
    slow.write = async (id, snap) => {
      await gate;
      return origWrite(id, snap);
    };
    __setSnapshotStoreForTests(slow);
    const saving = saveFeedSnapshot(owner, 'foryou', [match('m1')], null);
    await clearFeedSnapshots(); // sign-out while the write is still queued
    release();
    await saving;
    expect(slow.rows.size).toBe(0);
    expect(await loadFeedSnapshot(owner, 'foryou')).toBeNull();
  });

  it('a block or mute drops the snapshot so a restart cannot paint the blocked battle', async () => {
    const owner = feedOwnerKey('alice');
    await saveFeedSnapshot(owner, 'foryou', [match('m1')], null);
    bumpSocialGraphVersion();
    await new Promise((r) => setTimeout(r, 0));
    expect(store.rows.size).toBe(0);
    expect(await loadFeedSnapshot(owner, 'foryou')).toBeNull();
  });
});

describe('bounded, media-free payloads', () => {
  it('caps the item count', async () => {
    const owner = feedOwnerKey('alice');
    const many = Array.from({ length: MAX_SNAPSHOT_ITEMS + 10 }, (_, i) => match(`m${i}`));
    await saveFeedSnapshot(owner, 'foryou', many, 40);
    expect(store.rows.get(`${owner}|foryou`)?.items).toHaveLength(MAX_SNAPSHOT_ITEMS);
  });

  it('never stores inline image bytes (data: URIs) anywhere in an item', () => {
    const [clean] = sanitizeFeedItems([
      match('m1', {
        vsImageUrl: 'data:image/png;base64,AAAA',
        userA: { uid: 'a', mediaUrl: 'data:image/jpeg;base64,BBBB', profilePic: 'https://cdn.example/a.jpg' },
      }),
    ]);
    expect(JSON.stringify(clean)).not.toContain('data:');
    expect(clean.userA.profilePic).toBe('https://cdn.example/a.jpg');
  });

  it('trims to the byte ceiling', () => {
    const big = 'x'.repeat(Math.ceil(MAX_SNAPSHOT_BYTES / 4));
    const out = sanitizeFeedItems(Array.from({ length: 8 }, (_, i) => match(`m${i}`, { title: big })));
    expect(out.length).toBeGreaterThan(0);
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(MAX_SNAPSHOT_BYTES);
  });

  it('drops cancelled, long-finished, duplicate and id-less rows', () => {
    const now = Date.now();
    const out = sanitizeFeedItems(
      [
        match('keep'),
        match('keep'),
        match('gone', { status: 'cancelled' }),
        match('old', { status: 'completed', expiresAt: now - 2 * 86_400_000 }),
        match('recent', { status: 'completed', expiresAt: now - 3_600_000 }),
        { title: 'no id' },
        null,
      ],
      now,
    );
    expect(out.map((m) => m.id)).toEqual(['keep', 'recent']);
  });
});

describe('pagination', () => {
  it('load-more de-duplicates ids that overlap the current list', () => {
    const merged = appendPage([match('m1'), match('m2')], [match('m2'), match('m3'), match('m1'), match('m4')]);
    expect(merged.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm4']);
  });
});

describe('local store failures fall back to the network path', () => {
  it('a read failure is a miss, not a crash', async () => {
    __setSnapshotStoreForTests({
      read: async () => {
        throw new Error('SQLite setup failed');
      },
      write: async () => {},
      remove: async () => {},
    });
    await expect(loadFeedSnapshot(feedOwnerKey('alice'), 'foryou')).resolves.toBeNull();
  });

  it('a write failure does not reject (Home fires it and forgets)', async () => {
    __setSnapshotStoreForTests({
      read: async () => null,
      write: async () => {
        throw new Error('disk full');
      },
      remove: async () => {
        throw new Error('disk full');
      },
    });
    await expect(saveFeedSnapshot(feedOwnerKey('alice'), 'foryou', [match('m1')], null)).resolves.toBeUndefined();
    // The session tier still serves it, so this session keeps its fast remounts.
    expect(await loadFeedSnapshot(feedOwnerKey('alice'), 'foryou')).not.toBeNull();
    // And a failing disk clear still empties the session tier (privacy first).
    await expect(clearFeedSnapshots()).resolves.toBeUndefined();
    expect(await loadFeedSnapshot(feedOwnerKey('alice'), 'foryou')).toBeNull();
  });
});
