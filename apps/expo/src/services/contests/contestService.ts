import { 
  collection, 
  query, 
  where, 
  getDocs, 
  doc, 
  getDoc, 
  orderBy, 
  limit, 
  Timestamp 
} from 'firebase/firestore';
import { db } from '@/src/firebaseConfig';
import { Contest, Battle } from '@/src/types/contest';

export const contestService = {
  /**
   * Fetch all live contests for users to join
   */
  getLiveContests: async (type?: 'photo' | 'video'): Promise<Contest[]> => {
    try {
      const contestsRef = collection(db, 'contests');
      let q = query(
        contestsRef, 
        where('status', '==', 'live'),
        where('endDate', '>', Timestamp.now()),
        orderBy('endDate', 'asc')
      );

      if (type) {
        q = query(q, where('type', '==', type));
      }

      const querySnapshot = await getDocs(q);
      return querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Contest));
    } catch (error) {
      console.error("Error fetching live contests:", error);
      throw error;
    }
  },

  /**
   * Fetch active battles for the Home Feed
   */
  getActiveBattles: async (contestId?: string, limitCount: number = 20): Promise<Battle[]> => {
    try {
      const battlesRef = collection(db, 'battles');
      let q = query(
        battlesRef, 
        where('status', '==', 'active'),
        orderBy('createdAt', 'desc'),
        limit(limitCount)
      );

      if (contestId) {
        q = query(q, where('contestId', '==', contestId));
      }

      const querySnapshot = await getDocs(q);
      return querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Battle));
    } catch (error) {
      console.error("Error fetching active battles:", error);
      throw error;
    }
  },

  /**
   * Get specific contest details
   */
  getContestById: async (contestId: string): Promise<Contest | null> => {
    try {
      const docRef = doc(db, 'contests', contestId);
      const docSnap = await getDoc(docRef);
      if (docSnap.exists()) {
        return { id: docSnap.id, ...docSnap.data() } as Contest;
      }
      return null;
    } catch (error) {
      console.error("Error fetching contest details:", error);
      throw error;
    }
  }
};
