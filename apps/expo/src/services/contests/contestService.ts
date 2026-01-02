import { 
  collection, 
  query, 
  where, 
  getDocs, 
  doc, 
  getDoc, 
  orderBy, 
  limit 
} from 'firebase/firestore';
import { firestore } from '@/src/services/firebase/initFirebase';
import { Contest } from '@/src/types/contest';
import { getFunctions, httpsCallable } from 'firebase/functions';

const functions = getFunctions();

export const contestService = {
  /**
   * Fetch all available contest templates
   */
  getAvailableContests: async (type?: 'photo' | 'video'): Promise<Contest[]> => {
    try {
      const contestsRef = collection(firestore, 'contests');
      // Removed orderBy temporarily to avoid Index requirements while testing
      let q = query(
        contestsRef, 
        where('status', '==', 'live')
      );
      if (type) q = query(q, where('type', '==', type));
      const querySnapshot = await getDocs(q);
      return querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Contest));
    } catch (error) { console.error(error); throw error; }
  },

  /**
   * Fetch "Waiting for Opponent" matches
   * Filtered to only show PUBLIC matches in Explore
   */
  getWaitingMatches: async (type?: 'photo' | 'video', currentUserUid?: string): Promise<any[]> => {
    try {
      const matchesRef = collection(firestore, 'contestMatches');
      
      // Removed .where('isPrivate', '==', false) because legacy/new documents might miss this field,
      // and Firestore excludes documents where the field is missing.
      let q = query(
        matchesRef, 
        where('status', '==', 'waiting_for_opponent')
      );
      
      const querySnapshot = await getDocs(q);
      let matches = querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      
      // Client-side filtering for private matches
      // This allows matches with isPrivate=undefined to still show up (treating them as public)
      matches = matches.filter((m: any) => m.isPrivate !== true);

      if (type) {
        matches = matches.filter((m: any) => m.type === type);
      }
      return matches;
    } catch (error) { console.error(error); throw error; }
  },

  /**
   * Fetch private challenges sent to the current user
   */
  getMyChallenges: async (currentUserUid: string): Promise<any[]> => {
    try {
      const matchesRef = collection(firestore, 'contestMatches');
      const q = query(
        matchesRef,
        where('status', '==', 'waiting_for_opponent'),
        where('isPrivate', '==', true),
        where('invitedUid', '==', currentUserUid)
      );
      const querySnapshot = await getDocs(q);
      return querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    } catch (error) {
      console.error("Error fetching challenges:", error);
      return [];
    }
  },

  getActiveMatches: async (currentUserUid?: string, limitCount: number = 30): Promise<any[]> => {
    try {
      const matchesRef = collection(firestore, 'contestMatches');
      const activeQuery = query(
        matchesRef, 
        where('status', '==', 'active'),
        limit(limitCount)
      );
      const querySnapshot = await getDocs(activeQuery);
      let allMatches = querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

      if (!currentUserUid) return allMatches;

      const userRef = doc(firestore, 'users', currentUserUid);
      const userDoc = await getDoc(userRef);
      const followingIds = userDoc.data()?.following || [];

      return allMatches.sort((a: any, b: any) => {
        let scoreA = 0;
        let scoreB = 0;
        if (followingIds.includes(a.userA.uid) || followingIds.includes(a.userB.uid)) scoreA += 100;
        if (followingIds.includes(b.userA.uid) || followingIds.includes(b.userB.uid)) scoreB += 100;
        scoreA += (a.totalVotes || 0) * 2;
        scoreB += (b.totalVotes || 0) * 2;
        return scoreB - scoreA;
      });
    } catch (error) {
      console.error("Algorithm error:", error);
      return [];
    }
  },

  startMatch: async (data: { 
    contestId: string, 
    mediaUrl: string, 
    mediaType: string, 
    caption: string, 
    deviceId: string,
    invitedUid?: string // Added invitedUid for direct challenge
  }) => {
    const fn = httpsCallable(functions, 'startContestMatch');
    return await fn(data);
  },

  joinMatch: async (data: any) => {
    const fn = httpsCallable(functions, 'joinContestMatch');
    return await fn(data);
  },

  submitVote: async (matchId: string, votedForUid: string, deviceId: string) => {
    const fn = httpsCallable(functions, 'submitVote');
    return await fn({ matchId, votedForUid, deviceId });
  },

  getContestById: async (id: string) => {
    const docRef = doc(firestore, 'contests', id);
    const snap = await getDoc(docRef);
    return snap.exists() ? { id: snap.id, ...snap.data() } : null;
  },

  getMatchById: async (id: string) => {
    const docRef = doc(firestore, 'contestMatches', id);
    const snap = await getDoc(docRef);
    return snap.exists() ? { id: snap.id, ...snap.data() } : null;
  }
};
