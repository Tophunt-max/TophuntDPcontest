import { UserStories } from '@/src/types/stories';
import { auth } from '../firebase/initFirebase';
import { callApi, readApi } from '../api';

/**
 * Stories are fully backed by the Cloudflare Worker (D1 + R2) now.
 * Reads go through /read/* endpoints; writes go through /api actions.
 */

export const fetchStories = async (): Promise<UserStories[]> => {
  try {
    if (!auth.currentUser) return [];
    return (await readApi('/read/stories/feed')) as UserStories[];
  } catch (error) {
    console.error("[fetchStories] error:", error);
    return [];
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
  } catch (err) {
    console.error("markStoryAsSeen error:", err);
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
  await callApi('reactToStory', { storyId, emoji });
};

export const searchUsers = async (searchTerm: string) => {
  try {
    if (!searchTerm || searchTerm.length < 2) return [];
    return (await readApi('/read/users/search', { q: searchTerm })) as any[];
  } catch (error) {
    console.error("searchUsers error:", error);
    return [];
  }
};

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
