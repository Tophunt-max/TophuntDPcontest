import { firestore } from '@/src/services/firebase/initFirebase';
import { 
  doc, 
  updateDoc, 
  increment, 
  setDoc, 
  serverTimestamp,
  getDoc
} from 'firebase/firestore';
import { callApi } from '../api';

export const reactionService = {
  addReaction: async (battleId: string, userId: string, reactionType: string) => {
    try {
      const reactionRef = doc(firestore, `contestMatches/${battleId}/likes`, `${userId}`);
      
      await setDoc(reactionRef, {
        userId,
        type: reactionType,
        createdAt: serverTimestamp(),
      });

      const battleRef = doc(firestore, 'contestMatches', battleId);
      
      await updateDoc(battleRef, {
        likesCount: increment(1)
      });

      // --- NOTIFICATION LOGIC ---
      try {
          const battleDoc = await getDoc(battleRef);
          if (battleDoc.exists()) {
              const battleData = battleDoc.data();
              // Notify Battle Creator
              if (battleData.creatorId !== userId) {
                  await callApi('notificationApi', {
                      type: 'LIKE',
                      data: {
                          targetId: battleId,
                          targetType: 'match',
                          likerId: userId,
                          authorId: battleData.creatorId
                      }
                  });
              }
              // Notify Opponent
              if (battleData.opponentId && battleData.opponentId !== userId) {
                  await callApi('notificationApi', {
                      type: 'LIKE',
                      data: {
                          targetId: battleId,
                          targetType: 'match',
                          likerId: userId,
                          authorId: battleData.opponentId
                      }
                  });
              }
          }
      } catch (e) {
          console.warn("Battle notification failed:", e);
      }
      
      return true;
    } catch (error) {
      console.error("Error adding reaction:", error);
      throw error;
    }
  }
};
