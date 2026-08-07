import { readApi } from '../api';
import { UserProfile } from '@/src/types/user';

/** Leaderboards now come from the Worker /read/leaderboard (D1). */
export const leaderboardService = {
  getTopWinners: async (limitCount: number = 20): Promise<UserProfile[]> => {
    try {
      return (await readApi('/read/leaderboard', { by: 'wins', limit: limitCount })) as UserProfile[];
    } catch (error) {
      console.error("Error fetching top winners:", error);
      return [];
    }
  },

  getMostVoted: async (limitCount: number = 20): Promise<UserProfile[]> => {
    try {
      return (await readApi('/read/leaderboard', { by: 'votes', limit: limitCount })) as UserProfile[];
    } catch (error) {
      console.error("Error fetching most voted users:", error);
      return [];
    }
  },

  getTopLevels: async (limitCount: number = 20): Promise<UserProfile[]> => {
    try {
      return (await readApi('/read/leaderboard', { by: 'xp', limit: limitCount })) as UserProfile[];
    } catch (error) {
      console.error("Error fetching top levels:", error);
      return [];
    }
  },
};
