import { 
  collection, 
  query, 
  orderBy, 
  limit, 
  getDocs, 
  where 
} from 'firebase/firestore';
import { firestore } from '@/src/services/firebase/initFirebase';
import { UserProfile } from '@/src/types/user';

export const leaderboardService = {
  /**
   * Get top users by their number of wins
   * PRODUCTION: Only shows users who completed signup
   */
  getTopWinners: async (limitCount: number = 20): Promise<UserProfile[]> => {
    try {
      const usersRef = collection(firestore, 'users');
      const q = query(
        usersRef,
        where('signupCompleted', '==', true), // Ensure only valid users show up
        orderBy('stats.wins', 'desc'),
        limit(limitCount)
      );
      
      const snap = await getDocs(q);
      return snap.docs.map(doc => ({ uid: doc.id, ...doc.data() } as UserProfile));
    } catch (error) {
      console.error("Error fetching top winners:", error);
      // Fallback: If index is not yet created, retry without filter (for dev only)
      return [];
    }
  },

  /**
   * Get top users by total votes received
   */
  getMostVoted: async (limitCount: number = 20): Promise<UserProfile[]> => {
    try {
      const usersRef = collection(firestore, 'users');
      const q = query(
        usersRef,
        where('signupCompleted', '==', true),
        orderBy('stats.totalVotesReceived', 'desc'),
        limit(limitCount)
      );
      
      const snap = await getDocs(q);
      return snap.docs.map(doc => ({ uid: doc.id, ...doc.data() } as UserProfile));
    } catch (error) {
      console.error("Error fetching most voted users:", error);
      return [];
    }
  },

  /**
   * Get top users by XP/Level
   */
  getTopLevels: async (limitCount: number = 20): Promise<UserProfile[]> => {
    try {
      const usersRef = collection(firestore, 'users');
      const q = query(
        usersRef,
        where('signupCompleted', '==', true),
        orderBy('xp', 'desc'),
        limit(limitCount)
      );
      
      const snap = await getDocs(q);
      return snap.docs.map(doc => ({ uid: doc.id, ...doc.data() } as UserProfile));
    } catch (error) {
      console.error("Error fetching top levels:", error);
      return [];
    }
  }
};
