import { firestore } from '../firebase/initFirebase';
import { doc, updateDoc, increment, serverTimestamp } from 'firebase/firestore';
import { callApi } from '../api'; // Naya centralized API caller

export const walletService = {
  /**
   * Purchase coins (Mock Payment)
   */
  purchaseCoins: async (amount: number, price: string) => {
    try {
      // Mock payment ID
      const mockPaymentId = `pay_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      // Purana: httpsCallable(functions, 'topUpWallet')
      // Ab: Central API call ('topup' action as defined in main.ts)
      return await callApi('topup', {
        amount,
        paymentId: mockPaymentId
      });
    } catch (error) {
      console.error("Purchase error:", error);
      throw error;
    }
  },

  /**
   * Claim Daily Bonus
   */
  claimDailyBonus: async (userId: string, dayIndex: number) => {
    try {
        // Backend router mein 'claimDailyReward' action hai
        return await callApi('claimDailyReward', { dayIndex });
    } catch (error) {
        console.error("Error claiming daily bonus:", error);
        // Fallback or handle error
        throw error;
    }
  }
};
