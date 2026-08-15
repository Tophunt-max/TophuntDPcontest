import { callApi } from '../api';

export interface CreatedOrder {
  orderId: string;
  amount: number; // in paise
  currency: string;
  keyId: string;
  coins: number;
  name: string;
}

export const walletService = {
  /**
   * Step 1 of a coin purchase: ask the server to create a Razorpay order for a
   * coin package. Pricing and the number of coins are decided SERVER-SIDE from
   * the coin_packages table — the client only passes the package id. The
   * returned order + keyId are fed into the Razorpay checkout.
   */
  createOrder: async (packageId: string): Promise<CreatedOrder> => {
    try {
      return (await callApi('createOrder', { packageId })) as CreatedOrder;
    } catch (error) {
      console.error("createOrder error:", error);
      throw error;
    }
  },

  /**
   * Step 2: after checkout, hand the Razorpay proof back to the server. The
   * Worker verifies the signature and credits the coins recorded against the
   * order (never a client-supplied amount). "Fails closed" if unverified.
   */
  confirmTopup: async (proof: { paymentId: string; orderId: string; signature: string }) => {
    try {
      return await callApi('topup', proof);
    } catch (error) {
      console.error("confirmTopup error:", error);
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

  /**
   * Request a cash payout of Dpcoins. The Worker validates against the admin
   * withdrawal config (enabled / min amount / conversion rate) and creates a
   * pending request; coins are held by the admin on approval.
   */
  requestWithdrawal: async (amount: number, method: string, accountDetails: string) => {
    return await callApi('requestWithdrawal', { amount, method, accountDetails });
  },

  /**
   * Manual deposit request — user pays the admin's QR/UPI externally, then
   * submits the amount + bank UTR. Admin approves/rejects in the panel.
   */
  requestDeposit: async (amount: number, utr: string, method = 'qr') => {
    return await callApi('requestDeposit', { amount, utr, method });
  },
};
