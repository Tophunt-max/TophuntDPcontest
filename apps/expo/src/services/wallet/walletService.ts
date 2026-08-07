import { callApi } from '../api';

export const walletService = {
  /**
   * Purchase coins (mock payment) — credited via the Worker /api `topup`.
   */
  purchaseCoins: async (amount: number, _price: string) => {
    try {
      const mockPaymentId = `pay_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      return await callApi('topup', { amount, paymentId: mockPaymentId });
    } catch (error) {
      console.error("Purchase error:", error);
      throw error;
    }
  },

  /**
   * Claim daily bonus — handled by the Worker /api `claimDailyReward`.
   */
  claimDailyBonus: async (_userId: string, dayIndex: number) => {
    try {
      return await callApi('claimDailyReward', { dayIndex });
    } catch (error) {
      console.error("Error claiming daily bonus:", error);
      throw error;
    }
  },
};
