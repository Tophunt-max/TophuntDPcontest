import { firestore } from '../firebase/initFirebase';
import { doc, updateDoc, increment, serverTimestamp } from 'firebase/firestore';
import { callApi } from '../api'; 

export const walletService = {
  /**
   * Purchase coins (Mock Payment)
   */
  purchaseCoins: async (amount: number, price: string) => {
    try {
      const mockPaymentId = `pay_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
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
        return await callApi('claimDailyReward', { dayIndex });
    } catch (error) {
        console.error("Error claiming daily bonus:", error);
        throw error;
    }
  },

  /**
   * Lucky Spin Reward
   */
  claimLuckySpin: async (amount: number) => {
    try {
        return await callApi('luckySpin', { amount });
    } catch (error) {
        console.error("Error claiming lucky spin:", error);
        throw error;
    }
  }
};
