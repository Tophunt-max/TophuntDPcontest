import { 
  collection, 
  query, 
  orderBy, 
  limit, 
  getDocs, 
  where 
} from 'firebase/firestore';
import { db } from '@/src/firebaseConfig';
import { UserProfile } from '@/src/types/user';

export const leaderboardService = {
  /**
   * Get top users by their number of wins
   */
  getTopWinners: async (limitCount: number = 20): Promise<UserProfile[]> => {
    try {
      const usersRef = collection(db, 'users');
      // Query users who have at least one win, ordered by wins
      const q = query(
        usersRef,
        orderBy('stats.wins', 'desc'),
        limit(limitCount)
      );
      
      const snap = await getDocs(q);
      return snap.docs.map(doc => ({ uid: doc.id, ...doc.data() } as UserProfile));
    } catch (error) {
      console.error("Error fetching top winners:", error);
      return [];
    }
  },

  /**
   * Get top users by total votes received
   */
  getMostVoted: async (limitCount: number = 20): Promise<UserProfile[]> => {
    try {
      const usersRef = collection(db, 'users');
      const q = query(
        usersRef,
        orderBy('stats.totalVotesReceived', 'desc'),
        limit(limitCount)
      );
      
      const snap = await getDocs(q);
      return snap.docs.map(doc => ({ uid: doc.id, ...doc.data() } as UserProfile));
    } catch (error) {
      console.error("Error fetching most voted users:", error);
      return [];
    }
  }
};
