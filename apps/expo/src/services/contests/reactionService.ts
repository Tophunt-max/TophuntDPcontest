import { callApi } from '../api';

export const reactionService = {
  /**
   * Add a quick reaction to a battle ('fire' | 'heart' | 'laugh').
   * (Was battles/{id}/reactions + increment in Firestore; now a Worker action.)
   */
  addReaction: async (battleId: string, _userId: string, reactionType: string) => {
    try {
      await callApi('reactToMatch', { matchId: battleId, type: reactionType });
      return true;
    } catch (error) {
      console.error("Error adding reaction:", error);
      throw error;
    }
  },
};
