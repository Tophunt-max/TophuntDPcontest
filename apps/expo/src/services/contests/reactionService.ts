import { db } from '@/src/firebaseConfig';
import { 
  doc, 
  updateDoc, 
  increment, 
  setDoc, 
  collection, 
  serverTimestamp 
} from 'firebase/firestore';

export const reactionService = {
  /**
   * Add a quick reaction to a battle
   * @param battleId - ID of the battle
   * @param userId - ID of the user
   * @param reactionType - 'fire' | 'heart' | 'laugh'
   */
  addReaction: async (battleId: string, userId: string, reactionType: string) => {
    try {
      const reactionRef = doc(db, `battles/${battleId}/reactions`, `${userId}_${reactionType}`);
      
      // 1. Record individual reaction (to prevent spam if needed)
      await setDoc(reactionRef, {
        userId,
        type: reactionType,
        createdAt: serverTimestamp(),
      });

      // 2. Increment counter in main battle document
      const battleRef = doc(db, 'battles', battleId);
      const fieldName = `reactions.${reactionType}`;
      
      await updateDoc(battleRef, {
        [fieldName]: increment(1)
      });
      
      return true;
    } catch (error) {
      console.error("Error adding reaction:", error);
      throw error;
    }
  }
};
