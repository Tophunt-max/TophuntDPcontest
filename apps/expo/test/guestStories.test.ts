/**
 * Guest Story fetching and the device-wide Story cache.
 *
 * The on-device cache is NOT keyed by account, so a guest must never be served
 * (or have written) a previous account's Stories — followers-only ones above all.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  currentUser: null as any,
  readApi: vi.fn(),
  getLocal: vi.fn(async () => [{ userId: 'prev', username: 'prev', stories: [{ id: 'followers-only' }] }]),
  saveLocal: vi.fn(async () => undefined),
  replaceLocal: vi.fn(async () => undefined),
}));

vi.mock('@/src/services/firebase/initFirebase', () => ({
  auth: {
    get currentUser() {
      return h.currentUser;
    },
  },
}));
vi.mock('@/src/services/api', () => ({ readApi: h.readApi, callApi: vi.fn() }));
vi.mock('@/src/services/stories/offlineStoryService', () => ({
  getUserStoriesLocally: h.getLocal,
  saveUserStoriesLocally: h.saveLocal,
  replaceUserStoriesLocally: h.replaceLocal,
  storyCacheGenerationNow: () => 0,
  markStoryAsSeenLocally: vi.fn(),
  reactToStoryLocally: vi.fn(),
  queuePendingAction: vi.fn(),
  getUserStoriesByUserIdLocally: vi.fn(),
  syncPendingActions: vi.fn(),
  checkAndSync: vi.fn(),
  clearExpiredStories: vi.fn(),
}));

import { fetchStories } from '@/src/services/stories/storyService';

const PUBLIC_FEED = [{ userId: 'alice', username: 'alice', stories: [{ id: 'pub' }] }];

beforeEach(() => {
  h.readApi.mockReset();
  h.getLocal.mockClear();
  h.saveLocal.mockClear();
  h.replaceLocal.mockClear();
});

describe('fetchStories for a guest', () => {
  it('reads the public feed from the network and never touches the device cache', async () => {
    h.currentUser = null;
    h.readApi.mockResolvedValue(PUBLIC_FEED);
    const out = await fetchStories();
    expect(out).toEqual(PUBLIC_FEED);
    expect(h.readApi).toHaveBeenCalledWith('/read/stories/feed', { limit: 50 });
    expect(h.getLocal).not.toHaveBeenCalled();
    expect(h.saveLocal).not.toHaveBeenCalled();
    expect(h.replaceLocal).not.toHaveBeenCalled();
  });

  it('a failed guest fetch is an empty bar, not the previous account\'s cache', async () => {
    h.currentUser = null;
    h.readApi.mockRejectedValue(new Error('offline'));
    expect(await fetchStories()).toEqual([]);
    expect(h.getLocal).not.toHaveBeenCalled();
  });

  it('signed in: the server answer wins and REPLACES the device cache', async () => {
    // Cache-first + upsert-only kept serving Stories the server no longer shows
    // this viewer (unfollowed accounts, followers-only Stories cached earlier).
    h.currentUser = { uid: 'me' };
    h.readApi.mockResolvedValue(PUBLIC_FEED);
    const out = await fetchStories();
    expect(out).toEqual(PUBLIC_FEED);
    expect(h.getLocal).not.toHaveBeenCalled();
    // Owner + the generation captured before the request, so a response that
    // lands after an account switch is dropped instead of cached.
    expect(h.replaceLocal).toHaveBeenCalledWith(PUBLIC_FEED, 'me', 0);
  });

  it('signed in and offline: falls back to this account\'s cached answer', async () => {
    h.currentUser = { uid: 'me' };
    h.readApi.mockRejectedValue(new Error('offline'));
    const out = await fetchStories();
    expect(h.getLocal).toHaveBeenCalled();
    expect(out[0].userId).toBe('prev');
  });
});
