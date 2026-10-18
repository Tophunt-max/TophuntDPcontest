import { callApi } from '../api';

export const engagementService = {
  /**
   * Bookmark / unbookmark a battle. Returns the new bookmarked state.
   * (Was users/{uid}/bookmarks/{battleId} in Firestore; now a Worker action.)
   */
  toggleBookmark: async (battleId: string, _userId?: string) => {
    try {
      const res: any = await callApi('toggleBookmark', { matchId: battleId });
      return res.bookmarked;
    } catch (error) {
      console.error("Error toggling bookmark:", error);
      throw error;
    }
  },

  // Battle sharing lives in src/lib/share.ts + src/lib/vsShareAsset.ts (one
  // canonical VS image for every share path). The old `shareBattle` here sent a
  // placeholder link and no image, and had no callers.
};
