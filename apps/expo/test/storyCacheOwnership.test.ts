/**
 * The on-device Story cache belongs to ONE account.
 *
 * Two ways the previous account's followers-only Stories reached the next
 * person on the device:
 *  1. A Stories fetch in flight during sign-out finished AFTER the clear and
 *     wrote the old account's answer back to disk.
 *  2. The clear runs from a post-render effect; if the app died first (or the
 *     clear failed), the rows stayed and the next account's offline read
 *     returned them.
 * (1) is closed by a generation counter, (2) by an owner marker checked on read.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  const kv = new Map<string, string>();
  return {
    kv,
    currentUser: null as null | { uid: string },
    writes: 0,
    reads: [] as string[],
  };
});

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => (h.kv.has(k) ? h.kv.get(k)! : null),
    setItem: async (k: string, v: string) => void h.kv.set(k, v),
    removeItem: async (k: string) => void h.kv.delete(k),
  },
}));
vi.mock('@/src/database', () => ({
  database: {
    write: async (fn: () => Promise<void>) => {
      h.writes++;
      return fn();
    },
    get: (name: string) => {
      h.reads.push(name);
      return {
        query: () => ({ fetch: async () => [] }),
        find: async () => {
          throw new Error('absent');
        },
      };
    },
    batch: async () => undefined,
  },
  StoryModel: class {},
  UserStoryModel: class {},
  PendingActionModel: class {},
}));
vi.mock('@/src/services/firebase/initFirebase', () => ({
  auth: {
    get currentUser() {
      return h.currentUser;
    },
  },
}));
vi.mock('@react-native-community/netinfo', () => ({ default: { fetch: async () => ({ isConnected: false }) } }));
vi.mock('@nozbe/watermelondb', () => ({ Q: { where: () => ({}), oneOf: () => ({}) }, Model: class {} }));

const svc = await import('@/src/services/stories/offlineStoryService');

beforeEach(async () => {
  h.kv.clear();
  h.currentUser = null;
  await svc.clearLocalStories();
  h.writes = 0;
  h.reads.length = 0;
});

describe('Story cache ownership', () => {
  it('a cache filled for account A reads as empty for account B, and for a guest', async () => {
    await svc.replaceUserStoriesLocally([], 'alice');
    expect(h.kv.get(svc.STORY_CACHE_OWNER_KEY)).toBe('alice');

    h.reads.length = 0;
    h.currentUser = { uid: 'bob' };
    expect(await svc.getUserStoriesLocally()).toEqual([]);
    expect(await svc.getUserStoriesByUserIdLocally('alice')).toBeNull();
    h.currentUser = null;
    expect(await svc.getUserStoriesLocally()).toEqual([]);
    expect(h.reads).toEqual([]); // never even opened the tables

    h.currentUser = { uid: 'alice' };
    await svc.getUserStoriesLocally();
    expect(h.reads).toContain('user_stories'); // the owner's read proceeds
  });

  it('a cache with no owner marker (pre-upgrade install, failed write) fails closed', async () => {
    h.currentUser = { uid: 'alice' };
    expect(await svc.getUserStoriesLocally()).toEqual([]);
    expect(h.reads).toEqual([]);
  });

  it('clearing removes the owner marker', async () => {
    await svc.replaceUserStoriesLocally([], 'alice');
    await svc.clearLocalStories();
    expect(h.kv.has(svc.STORY_CACHE_OWNER_KEY)).toBe(false);
  });

  it('a fetch that started before a clear does not write its answer back', async () => {
    const startedAt = svc.storyCacheGenerationNow();
    await svc.clearLocalStories(); // sign-out lands while the request is in flight
    h.writes = 0;

    await svc.replaceUserStoriesLocally(
      [{ userId: 'alice', username: 'alice', stories: [], hasUnseen: true } as any],
      'alice',
      startedAt,
    );

    expect(h.writes).toBe(0);
    expect(h.kv.has(svc.STORY_CACHE_OWNER_KEY)).toBe(false);
  });
});
