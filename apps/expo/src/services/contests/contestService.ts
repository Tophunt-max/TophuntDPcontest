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
import { callApi } from '../api'; 
import { getOptimizedMediaUrl } from '../../utils/media';
import { prefetchMedia, getCachedMedia } from '../media/MediaCacheService';
import { Image } from 'expo-image';

export const contestService = {
  /**
   * Fetch all available contest templates (Admin created)
   */
  getAvailableContests: async (type?: 'photo' | 'video'): Promise<Contest[]> => {
    try {
      const contestsRef = collection(firestore, 'contests');
      let q = query(contestsRef, where('status', '==', 'live'));
      if (type) q = query(q, where('type', '==', type));
      const querySnapshot = await getDocs(q);
      return querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Contest));
    } catch (error) { console.error(error); throw error; }
  },

  /**
   * Fetch "Waiting for Opponent" matches
   */
  getWaitingMatches: async (type?: 'photo' | 'video'): Promise<any[]> => {
    try {
      const matchesRef = collection(firestore, 'contestMatches');
      let q = query(matchesRef, where('status', '==', 'waiting_for_opponent'));
      const querySnapshot = await getDocs(q);
      let matches = querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      if (type) matches = matches.filter((m: any) => m.type === type);
      return matches;
    } catch (error) { console.error(error); throw error; }
  },

  /**
   * Fetch Active Battles for Home Feed
   */
  getActiveMatches: async (currentUserUid?: string, limitCount: number = 30): Promise<any[]> => {
    try {
      const matchesRef = collection(firestore, 'contestMatches');
      const activeQuery = query(
        matchesRef, 
        where('status', '==', 'active'),
        limit(limitCount)
      );
      const querySnapshot = await getDocs(activeQuery);
      const matches = querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

      // Prefetch media for each match
      matches.forEach((match: any) => {
        if (match.userA?.mediaUrl) {
            const urlA = getOptimizedMediaUrl(match.userA.mediaUrl);
            if (match.type === 'video') prefetchMedia(urlA);
            else Image.prefetch(urlA);
        }
        if (match.userB?.mediaUrl) {
            const urlB = getOptimizedMediaUrl(match.userB.mediaUrl);
            if (match.type === 'video') prefetchMedia(urlB);
            else Image.prefetch(urlB);
        }
      });

      return matches;
    } catch (error) { console.error("Error fetching active matches:", error); return []; }
  },

  startMatch: async (data: any) => {
    return await callApi('startMatch', data);
  },

  joinMatch: async (data: any) => {
    return await callApi('joinMatch', data);
  },

  /**
   * Vote on a participant in a Match
   */
  voteOnMatch: async (matchId: string, votedForUid: string, deviceId: string = 'unknown') => {
    try {
      // Backend (voting.ts) expects matchId and votedForUid
      return await callApi('submitVote', { matchId, votedForUid, deviceId });
    } catch (error) { console.error("Error submitting vote:", error); throw error; }
  },

  /**
   * Joint Like on a Match
   */
  likeMatch: async (matchId: string) => {
    try {
      return await callApi('likeContest', { matchId });
    } catch (error) { console.error("Error liking match:", error); throw error; }
  },

  /**
   * Joint Comment on a Match
   */
  commentOnMatch: async (matchId: string, text: string) => {
    try {
      // @ts-ignore
      return await callApi('commentContest', { matchId, text });
    } catch (error) { console.error("Error commenting on match:", error); throw error; }
  },

  /**
   * Joint Share a Match
   */
  shareMatch: async (matchId: string) => {
    try {
      return await callApi('shareContest', { matchId });
    } catch (error) { console.error("Error sharing match:", error); throw error; }
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
