import { UserStories } from '@/src/types/stories';import { debounce } from '@/src/lib/debounce';

import { auth } from '../firebase/initFirebase';
import { callApi, readApi } from '../api';

/**
 * Stories are fully backed by the Cloudflare Worker (D1 + R2) now.
 * Reads go through /read/* endpoints; writes go through /api actions.
 */

export const fetchStories = async (limit: number = 50, forceRefresh: boolean = false): Promise<UserStories[]> => {
  try {
    if (!auth.currentUser) return [];
    
    // If not forcing refresh, try to get from local cache first
    if (!forceRefresh) {
      const localStories = await getUserStoriesLocally();
      if (localStories.length > 0) {
        return localStories;
      }
    }
    
    // Fetch from server
    const response = await readApi('/read/stories/feed', { limit });
    if (!Array.isArray(response)) {
      console.error("[fetchStories] Invalid response format:", response);
      return [];
    }
    
    const stories = response as UserStories[];
    
    // Save to local database
    for (const userStories of stories) {
      await saveUserStoriesLocally(userStories);
    }
    
    return stories;
  } catch (error) {
    console.error("[fetchStories] error:", error);
    // Fallback to local cache if online fetch fails
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
) => {
  const user = auth.currentUser;
  if (!user) throw new Error('User not authenticated');
  const data: any = await callApi('createStory', {
    mediaUrl,
    mediaType,
    visibility,
    overlayText,
    textPosition,
    mentions,
  });
  if (data && data.success) return data.storyId;
  throw new Error(data?.message || "Failed to create story record on server.");
};

export const deleteStory = async (storyId: string) => {
  if (!auth.currentUser) throw new Error('Unauthenticated');
  await callApi('deleteStory', { storyId });
};

export const markStoryAsSeen = async (storyId: string) => {
  if (!auth.currentUser) return;
  try {
    await callApi('viewStory', { storyId });
    // Also mark as seen locally
    await markStoryAsSeenLocally(storyId);
  } catch (err) {
    console.error("markStoryAsSeen error:", err);
    // Queue for sync when online
    await queuePendingAction({
      type: 'view',
      storyId,
      userId: auth.currentUser.uid,
      data: {},
    });
  }
};

export const fetchStoryViewers = async (storyId: string) => {
  try {
    return (await readApi(`/read/stories/${storyId}/viewers`)) as any[];
  } catch (error) {
    console.error("fetchStoryViewers error:", error);
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
    console.error("fetchUserHighlights error:", error);
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
    console.error("fetchHighlightStories error:", error);
    return null;
  }
};

export const reactToStory = async (storyId: string, emoji: string) => {
  if (!auth.currentUser) return;
  try {
    await callApi('reactToStory', { storyId, emoji });
    // Also react locally
    await reactToStoryLocally(storyId, emoji);
  } catch (err) {
    console.error("reactToStory error:", err);
    // Queue for sync when online
    await queuePendingAction({
      type: 'reaction',
      storyId,
      userId: auth.currentUser.uid,
      data: { emoji },
    });
  }
};

// Debounced version of searchUsers to reduce API calls
export const searchUsers = debounce(async (searchTerm: string) => {
  try {
    if (!searchTerm || searchTerm.length < 2) return [];
    return (await readApi('/read/users/search', { q: searchTerm })) as any[];
  } catch (error) {
    console.error("searchUsers error:", error);
    return [];
  }
}, 300); // 300ms debounce delay

export const fetchUserStoriesByUserId = async (userId: string): Promise<UserStories | null> => {
  try {
    return (await readApi(`/read/users/${userId}/stories`)) as UserStories | null;
  } catch (error) {
    console.error("fetchUserStoriesByUserId error:", error);
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
    console.error("fetchUserStoriesByUsername error:", error);
    return null;
  }
};

/**
 * Sync local changes with server (call this when app comes online)
 */
export const syncStories = async (): Promise<void> => {
  await checkAndSync();
};
