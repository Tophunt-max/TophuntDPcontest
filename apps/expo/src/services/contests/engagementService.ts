import { Share, Alert, Platform } from 'react-native';
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

  /**
   * Share a battle link/message via the native share sheet, and record the
   * share on the server for the share counter.
   */
  shareBattle: async (contestName: string, userA: string, userB: string, battleId?: string) => {
    try {
      const message = `Check out this VS Battle on our App!\n\n${userA} VS ${userB}\nContest: ${contestName}\n\nDownload the app to vote and earn coins!`;

      const result = await Share.share({
        message,
        title: `VS Battle: ${contestName}`,
        url: Platform.OS === 'ios' ? 'https://yourapp.link/battle' : undefined,
      });

      if (result.action === Share.sharedAction) {
        if (battleId) callApi('shareContest', { matchId: battleId }).catch(() => {});
        return true;
      }
      return false;
    } catch (error: any) {
      Alert.alert("Error", error.message);
      return false;
    }
  },
};
