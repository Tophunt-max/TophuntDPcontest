import { UserStories, StoryViewer } from '@/src/types/stories';

import { auth } from '../firebase/initFirebase';
import { callApi, readApi } from '../api';
import {
  getUserStoriesLocally,
  replaceUserStoriesLocally,
  markStoryAsSeenLocally,
  reactToStoryLocally,
  queuePendingAction,
  checkAndSync,
} from './offlineStoryService';

/**
 * Stories are fully backed by the Cloudflare Worker (D1 + R2) now.
 * Reads go through /read/* endpoints; writes go through /api actions.
 *
 * The local-cache helpers above come from ./offlineStoryService — every one of
 * them used to be called here without being imported, which made this whole
 * module throw ReferenceError at runtime.
 */

/**
 * When replaying the offline queue we must not re-queue on failure, or a
 * permanently failing action grows the queue without bound on every sync pass.
 */
type MutationOptions = { queueOnFailure?: boolean };

export interface FetchStoriesOptions {
  limit?: number;
  /** Skip the local cache and go straight to the network. */
  forceRefresh?: boolean;
}

/**
 * NOTE: takes a single options object. It must never be passed directly as a
 * react-query `queryFn` — react-query would supply its QueryFunctionContext as
 * the first argument. Call it as `queryFn: () => fetchStories()`.
 */
export const fetchStories = async (
  options: FetchStoriesOptions = {},
): Promise<UserStories[]> => {
  const { limit = 50, forceRefresh = false } = options;
  // Guests browse the PUBLIC stories bar straight from the network. The local
  // WatermelonDB cache is device-wide (not keyed by viewer), so it is neither
  // read nor written for a guest: a previous account's followers-only Stories
  // must never be served to a signed-out visitor from disk.
  if (!auth.currentUser) {
    try {
      const response = await readApi('/read/stories/feed', { limit });
      return Array.isArray(response) ? (response as UserStories[]) : [];
    } catch (error) {
      console.error('[fetchStories] guest fetch error:', error);
      return [];
    }
  }
  // Signed in: NETWORK FIRST, the device cache only as the offline fallback.
  // It used to be cache-first and upsert-only, which kept serving Stories the
  // server no longer shows this viewer (unfollowed accounts, followers-only
  // Stories cached before the audience rule). React Query keeps the previous
  // list on screen while this resolves, so the bar does not blank. `forceRefresh`
  // is kept for callers; both paths now go to the network.
  void forceRefresh;
  try {
    const response = await readApi('/read/stories/feed', { limit });
    if (!Array.isArray(response)) {
      console.error('[fetchStories] Invalid response format:', response);
      return await getUserStoriesLocally();
    }
    const stories = response as UserStories[];
    await replaceUserStoriesLocally(stories);
    return stories;
  } catch (error) {
    console.error('[fetchStories] error:', error);
    // Offline: the last answer the server gave THIS account (the cache is wiped
    // on every account change). getUserStoriesLocally never throws.
    return await getUserStoriesLocally();
  }
};

export const createStoryRecord = async (
  mediaUrl: string,
  mediaType: 'image' | 'video',
  visibility: 'public' | 'followers' = 'followers',
  overlayText?: string | null,
  textPosition?: { x: number; y: number } | null,
  mentions?: string[],
  /**
   * Chosen soundtrack. ONLY the track id is sent: the Worker re-resolves the
   * title, artist, artwork and preview URL from the provider and stores those.
   * Sending a preview URL from here would let any client have an arbitrary URL
   * loaded by every viewer's browser. See apps/worker/src/lib/music.ts.
   */
  musicTrackId?: string | null,
  /**
   * Where in the track to start, in ms. Sent only alongside a track — an offset
   * without a song is meaningless. The server sanitises it and every reader is
   * defensive, so an out-of-range value degrades to 0:00 rather than to silence.
   */
  musicStartMs?: number | null,
): Promise<{ storyId: string; musicAttached: boolean }> => {
  const user = auth.currentUser;
  if (!user) throw new Error('User not authenticated');
  const data: any = await callApi('createStory', {
    mediaUrl,
    mediaType,
    visibility,
    overlayText,
    textPosition,
    mentions,
    musicTrackId: musicTrackId || undefined,
    // Omitted entirely for "from the beginning", so the field means the same
    // thing on the wire as it does in the column.
    musicStartMs: musicTrackId && musicStartMs ? musicStartMs : undefined,
  });
  if (data && data.success) {
    // `musicAttached` is false when a track WAS chosen but the provider lookup
    // failed. The story is published either way — the caller decides whether to
    // mention the loss, which is better than silently posting a silent story.
    return { storyId: data.storyId, musicAttached: !!data.musicAttached };
  }
  throw new Error(data?.message || 'Failed to create story record on server.');
};

export const deleteStory = async (storyId: string) => {
  if (!auth.currentUser) throw new Error('Unauthenticated');
  await callApi('deleteStory', { storyId });
};

export const markStoryAsSeen = async (
  storyId: string,
  { queueOnFailure = true }: MutationOptions = {},
) => {
  if (!auth.currentUser) return;
  try {
    await callApi('viewStory', { storyId });
    await markStoryAsSeenLocally(storyId);
  } catch (err) {
    console.error('markStoryAsSeen error:', err);
    if (!queueOnFailure) throw err;
    await queuePendingAction({
      type: 'view',
      storyId,
      userId: auth.currentUser.uid,
      data: {},
    });
  }
};

export const fetchStoryViewers = async (storyId: string): Promise<StoryViewer[]> => {
  try {
    return ((await readApi(`/read/stories/${storyId}/viewers`)) as StoryViewer[]) || [];
  } catch (error) {
    console.error('fetchStoryViewers error:', error);
    return [];
  }
};

export const createHighlight = async (name: string, coverImageUrl: string, storyIds: string[]) => {
  if (!auth.currentUser) throw new Error('Unauthenticated');
  return await callApi('createHighlight', { name, coverImageUrl, storyIds });
};

export const fetchUserHighlights = async (userId: string) => {
  try {
    return (await readApi(`/read/users/${userId}/highlights`)) as any[];
  } catch (error) {
    console.error('fetchUserHighlights error:', error);
    return [];
  }
};

export const addStoryToHighlight = async (highlightId: string, storyId: string) => {
  if (!auth.currentUser) return;
  await callApi('addStoryToHighlight', { highlightId, storyId });
};

export const fetchHighlightStories = async (
  _userId: string,
  highlightId: string,
): Promise<UserStories | null> => {
  try {
    return (await readApi(`/read/highlights/${highlightId}/stories`)) as UserStories | null;
  } catch (error) {
    console.error('fetchHighlightStories error:', error);
    return null;
  }
};

export const reactToStory = async (
  storyId: string,
  emoji: string,
  { queueOnFailure = true }: MutationOptions = {},
) => {
  if (!auth.currentUser) return;
  try {
    await callApi('reactToStory', { storyId, emoji });
    await reactToStoryLocally(storyId, emoji);
  } catch (err) {
    console.error('reactToStory error:', err);
    if (!queueOnFailure) throw err;
    await queuePendingAction({
      type: 'reaction',
      storyId,
      userId: auth.currentUser.uid,
      data: { emoji },
    });
  }
};

/**
 * Mention autocomplete lookup.
 *
 * Deliberately NOT wrapped in `debounce()`. The debounce helper returns void, so
 * wrapping it here made `await searchUsers(q)` resolve to undefined and the
 * mention list could never populate. Callers debounce their own input — see
 * `app/story/create/index.tsx`, which already trails the query by 300ms.
 */
export const searchUsers = async (searchTerm: string): Promise<any[]> => {
  try {
    if (!searchTerm || searchTerm.length < 2) return [];
    return ((await readApi('/read/users/search', { q: searchTerm })) as any[]) || [];
  } catch (error) {
    console.error('searchUsers error:', error);
    return [];
  }
};

export const fetchUserStoriesByUserId = async (userId: string): Promise<UserStories | null> => {
  try {
    return (await readApi(`/read/users/${userId}/stories`)) as UserStories | null;
  } catch (error) {
    console.error('fetchUserStoriesByUserId error:', error);
    return null;
  }
};

export const fetchUserStoriesByUsername = async (username: string): Promise<UserStories | null> => {
  try {
    const matches: any[] = (await readApi('/read/users/search', { q: username })) || [];
    const exact = matches.find((u) => (u.username || '').toLowerCase() === username.toLowerCase());
    if (!exact) return null;
    return await fetchUserStoriesByUserId(exact.id);
  } catch (error) {
    console.error('fetchUserStoriesByUsername error:', error);
    return null;
  }
};

/**
 * Sync local changes with the server (call when the app comes back online).
 */
export const syncStories = async (): Promise<void> => {
  await checkAndSync();
};
