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
   * Credit a rewarded-ad view. The server enforces a daily cap + rate limit and
   * returns { coinsEarned, remaining }. (Server-Side Verification of the ad
   * should gate this before production — see PRODUCTION_TODO.md.)
   */
  claimAdReward: async () => {
    try {
      return await callApi('claimAdReward', {});
    } catch (error) {
      console.error("Error claiming ad reward:", error);
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
   * submits the bank UTR (+ optional payment screenshot).
   *
   * Takes a coin package rather than an amount: the server derives both the
   * coins to credit and the rupees expected from coin_packages, so pricing has
   * a single source of truth and the client cannot name its own price.
   */
  requestDeposit: async (packageId: string, utr: string, method = 'qr', screenshotUrl?: string) => {
    return await callApi('requestDeposit', { packageId, utr, method, screenshotUrl });
  },

  /** Daily tasks with live progress + claim state. */
  getDailyTasks: async () => {
    return await callApi('getDailyTasks', {});
  },

  /** Claim a completed daily task's reward. */
  claimDailyTask: async (taskId: string) => {
    return await callApi('claimDailyTask', { taskId });
  },
};
