/**
 * Signing out / switching accounts wipes the device-wide Story CONTENT cache so
 * the next viewer never sees the previous account's Stories. Queued actions are
 * kept: they carry their owner's uid and only that account ever replays them.
 */
import { describe, it, expect, vi } from 'vitest';

const h = vi.hoisted(() => {
  const destroyed: string[] = [];
  const table = (name: string, ids: string[]) =>
    ids.map((id) => ({ id, prepareDestroyPermanently: () => `${name}:${id}` }));
  const tables: Record<string, any[]> = {
    stories: table('stories', ['s1', 's2']),
    user_stories: table('user_stories', ['u1']),
    pending_actions: table('pending_actions', ['p1']),
  };
  return {
    destroyed,
    database: {
      write: async (fn: () => Promise<void>) => fn(),
      get: (name: string) => ({ query: () => ({ fetch: async () => tables[name] ?? [] }) }),
      batch: async (...ops: string[]) => {
        destroyed.push(...ops);
      },
    },
  };
});

vi.mock('@/src/database', () => ({ database: h.database, StoryModel: class {}, UserStoryModel: class {}, PendingActionModel: class {} }));
vi.mock('@/src/services/firebase/initFirebase', () => ({ auth: { currentUser: null } }));
vi.mock('@react-native-community/netinfo', () => ({ default: { fetch: async () => ({ isConnected: false }) } }));
vi.mock('@nozbe/watermelondb', () => ({ Q: {}, Model: class {} }));

import { clearLocalStories } from '@/src/services/stories/offlineStoryService';

describe('clearLocalStories', () => {
  it('destroys every cached story and story group, but keeps uid-scoped queued actions', async () => {
    await clearLocalStories();
    expect(h.destroyed.sort()).toEqual(['stories:s1', 'stories:s2', 'user_stories:u1']);
  });
});
