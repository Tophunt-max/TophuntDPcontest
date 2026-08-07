import { Contest } from '@/src/types/contest';
import { callApi, readApi } from '../api';

/**
 * All reads now hit the Cloudflare Worker /read endpoints (D1) instead of
 * Firestore; all mutations go through the Worker /api (callApi).
 */
export const contestService = {
  /** Fetch all available contest templates (admin created). */
  getAvailableContests: async (type?: 'photo' | 'video'): Promise<Contest[]> => {
    try {
      return (await readApi('/read/contests', { type })) as Contest[];
    } catch (error) { console.error(error); throw error; }
  },

  /** Fetch "Waiting for Opponent" matches. */
  getWaitingMatches: async (type?: 'photo' | 'video'): Promise<any[]> => {
    try {
      return (await readApi('/read/matches', { status: 'waiting_for_opponent', type })) as any[];
    } catch (error) { console.error(error); throw error; }
  },

  /** Fetch active battles for the home feed. */
  getActiveMatches: async (_currentUserUid?: string, limitCount: number = 30): Promise<any[]> => {
    try {
      return (await readApi('/read/matches', { status: 'active', limit: limitCount })) as any[];
    } catch (error) { console.error("Error fetching active matches:", error); return []; }
  },

  startMatch: async (data: any) => callApi('startMatch', data),

  joinMatch: async (data: any) => callApi('joinMatch', data),

  /** Vote on a participant in a match. */
  voteOnMatch: async (matchId: string, votedForUid: string, deviceId: string = 'unknown') => {
    try {
      return await callApi('submitVote', { matchId, votedForUid, deviceId });
    } catch (error) { console.error("Error submitting vote:", error); throw error; }
  },

  likeMatch: async (matchId: string) => {
    try { return await callApi('likeContest', { matchId }); }
    catch (error) { console.error("Error liking match:", error); throw error; }
  },

  commentOnMatch: async (matchId: string, text: string) => {
    try { return await callApi('commentContest', { matchId, text }); }
    catch (error) { console.error("Error commenting on match:", error); throw error; }
  },

  shareMatch: async (matchId: string) => {
    try { return await callApi('shareContest', { matchId }); }
    catch (error) { console.error("Error sharing match:", error); throw error; }
  },

  getContestById: async (id: string) => readApi(`/read/contests/${id}`),

  getMatchById: async (id: string) => readApi(`/read/matches/${id}`),
};
