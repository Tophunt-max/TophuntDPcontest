import { getFunctions, httpsCallable } from 'firebase/functions';
import { firestore } from '../firebase/initFirebase';
import { doc, updateDoc, increment, serverTimestamp } from 'firebase/firestore';

export const walletService = {
  /**
   * Purchase coins (Mock Payment)
   */
  purchaseCoins: async (amount: number, price: string) => {
    try {
      // Here you would normally integrate Stripe/Razorpay
      // For now, we simulate a successful payment ID
      const mockPaymentId = `pay_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      const functions = getFunctions();
      const topUpFn = httpsCallable(functions, 'topUpWallet');
      
      const result: any = await topUpFn({
        amount,
        paymentId: mockPaymentId
      });

      return result.data;
    } catch (error) {
      console.error("Purchase error:", error);
      throw error;
    }
  },

  /**
   * Claim Daily Bonus
   * Returns the amount claimed
   */
  claimDailyBonus: async (userId: string, dayIndex: number) => {
    // In a real app, use a Cloud Function to prevent time-hack cheating.
    // For this prototype, we update Firestore directly.
    const rewards = [10, 15, 20, 25, 30, 50, 100];
    const amount = rewards[dayIndex] || 10;

    const userRef = doc(firestore, 'users', userId);
    
    await updateDoc(userRef, {
        Dpcoin: increment(amount),
        lastDailyBonus: serverTimestamp(),
        dailyStreak: dayIndex + 1 // Increment streak
    });

    return amount;
  }
};
