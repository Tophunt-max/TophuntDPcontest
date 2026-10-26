/**
 * Sign-out wipes the previous account's on-device data BEFORE it resolves,
 * rather than relying only on the post-render effect in app/_layout.tsx (which
 * never runs if the app is killed first). A failing step must not block logout
 * or skip the other steps.
 */
import { describe, it, expect, vi } from 'vitest';

const h = vi.hoisted(() => ({
  stories: vi.fn(async () => undefined),
  feed: vi.fn(async () => undefined),
  searches: vi.fn(async () => undefined),
}));

vi.mock('@/src/services/stories/offlineStoryService', () => ({ clearLocalStories: h.stories }));
vi.mock('@/src/lib/feedSnapshot', () => ({ clearFeedSnapshots: h.feed }));
vi.mock('@/src/services/explore', () => ({ clearRecentSearches: h.searches }));
vi.mock('firebase/auth', () => ({ signOut: vi.fn(), createUserWithEmailAndPassword: vi.fn() }));
vi.mock('@/src/services/firebase/initFirebase', () => ({ auth: { currentUser: null } }));
vi.mock('@/src/services/api', () => ({ callApi: vi.fn(), beginDeliberateSignOut: vi.fn(), endDeliberateSignOut: vi.fn() }));
vi.mock('@/src/services/notifications/notificationService', () => ({ notificationService: {} }));
vi.mock('@/src/lib/cachedIdentity', () => ({ clearCachedIdentity: vi.fn() }));
// auth.ts re-exports the useAuth hook; it is not under test here.
vi.mock('@/src/hooks/useAuth', () => ({ useAuth: vi.fn() }));

const { clearAccountScopedCaches } = await import('@/src/services/auth');

describe('clearAccountScopedCaches', () => {
  it('clears stories, the Home snapshot and recent searches', async () => {
    await clearAccountScopedCaches();
    expect(h.stories).toHaveBeenCalledTimes(1);
    expect(h.feed).toHaveBeenCalledTimes(1);
    expect(h.searches).toHaveBeenCalledTimes(1);
  });

  it('one failing step neither throws nor skips the others', async () => {
    h.stories.mockClear();
    h.feed.mockClear();
    h.searches.mockClear();
    h.stories.mockRejectedValueOnce(new Error('db locked'));
    await expect(clearAccountScopedCaches()).resolves.toBeUndefined();
    expect(h.feed).toHaveBeenCalledTimes(1);
    expect(h.searches).toHaveBeenCalledTimes(1);
  });
});
