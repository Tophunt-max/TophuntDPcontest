import { Contest } from '@/src/types/contest';
import { callApi, readApi } from '../api';
import { getDeviceId } from '@/src/lib/deviceId';

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

  /**
   * Fetch a page of home-feed battles, ranked by the personalized algorithm.
   *  - sort 'foryou'    → freshness + engagement velocity + closing-soon +
   *                       affinity (follows/votes/visits) − fatigue.
   *  - sort 'following' → only battles featuring creators you follow.
   * Returns { items, nextCursor }; pass nextCursor back for the next page
   * (infinite scroll). Signed-out users get content ranking server-side.
   */
  getActiveMatches: async (
    opts: { sort?: 'foryou' | 'following'; cursor?: number | string | null; limit?: number } = {},
  ): Promise<{ items: any[]; nextCursor: number | string | null }> => {
    const { sort = 'foryou', cursor = null, limit = 8 } = opts;
    try {
      const res: any = await readApi('/read/matches', {
        status: 'active',
        sort,
        cursor: cursor ?? undefined,
        limit,
      });
      // Tolerate both the paginated shape and a legacy bare array.
      if (Array.isArray(res)) return { items: res, nextCursor: null };
      return { items: res?.items || [], nextCursor: res?.nextCursor ?? null };
    } catch (error) {
      console.error("Error fetching active matches:", error);
      throw error;
    }
  },

  startMatch: async (data: any) => callApi('startMatch', data),

  joinMatch: async (data: any) => callApi('joinMatch', data),

  /** Vote on a participant in a match using this installation's stable ID. */
  voteOnMatch: async (matchId: string, votedForUid: string) => {
    try {
      // Device identity is owned here so UI callers cannot accidentally send a
      // shared placeholder that locks every other voter out of the match.
      const deviceId = await getDeviceId();
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
