import { db } from '@/src/firebaseConfig';
import { 
  doc, 
  setDoc, 
  deleteDoc, 
  getDoc,
  serverTimestamp 
} from 'firebase/firestore';
import { Share, Alert, Platform } from 'react-native';

export const engagementService = {
  /**
   * Bookmark or Unbookmark a battle
   */
  toggleBookmark: async (battleId: string, userId: string) => {
    try {
      const bookmarkRef = doc(db, `users/${userId}/bookmarks`, battleId);
      const docSnap = await getDoc(bookmarkRef);

      if (docSnap.exists()) {
        // Remove bookmark
        await deleteDoc(bookmarkRef);
        return false; // Not bookmarked anymore
      } else {
        // Add bookmark
        await setDoc(bookmarkRef, {
          battleId,
          savedAt: serverTimestamp(),
        });
        return true; // Bookmarked
      }
    } catch (error) {
      console.error("Error toggling bookmark:", error);
      throw error;
    }
  },

  /**
   * Share a battle link or message
   */
  shareBattle: async (contestName: string, userA: string, userB: string) => {
    try {
      const message = `Check out this VS Battle on our App! 🏆\n\n${userA} VS ${userB}\nContest: ${contestName}\n\nDownload the app to vote and earn coins!`;
      
      const result = await Share.share({
        message,
        title: `VS Battle: ${contestName}`,
        url: Platform.OS === 'ios' ? 'https://yourapp.link/battle' : undefined,
      });

      if (result.action === Share.sharedAction) {
        return true;
      }
      return false;
    } catch (error: any) {
      Alert.alert("Error", error.message);
      return false;
    }
  }
};
