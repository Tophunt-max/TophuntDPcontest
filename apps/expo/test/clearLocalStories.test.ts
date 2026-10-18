/**
 * Signing out / switching accounts wipes the device-wide Story cache, including
 * queued Story actions, so the next viewer can neither see nor replay the
 * previous account's data.
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
  it('destroys every cached story, story group and queued story action', async () => {
    await clearLocalStories();
    expect(h.destroyed.sort()).toEqual(['pending_actions:p1', 'stories:s1', 'stories:s2', 'user_stories:u1']);
  });
});
