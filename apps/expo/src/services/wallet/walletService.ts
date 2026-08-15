import { callApi } from '../api';

export const walletService = {
  /**
   * Purchase coins — credited via the Worker /api `topup`.
   *
   * IMPORTANT: The Worker verifies the payment server-side and requires a real
   * Razorpay proof (`orderId`, `paymentId`, `signature`). It deliberately
   * "fails closed" — coins are never minted without a verified payment. A real
   * Razorpay checkout flow (order creation + signature) must supply `proof`
   * before this can succeed; there is no client-side mock that will pass.
   */
  purchaseCoins: async (
    amount: number,
    _price: string,
    proof?: { paymentId: string; orderId: string; signature: string },
  ) => {
    try {
      return await callApi('topup', { amount, ...(proof || {}) });
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
