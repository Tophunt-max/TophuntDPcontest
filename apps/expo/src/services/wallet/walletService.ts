import { getFunctions, httpsCallable } from 'firebase/functions';

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
  }
};
