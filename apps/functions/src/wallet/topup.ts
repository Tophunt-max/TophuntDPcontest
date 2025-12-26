import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";

/**
 * Top-up Fish Coins for a user after successful payment.
 */
export const topUpWallet = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "User must be logged in.");
  }

  const { amount, paymentId } = request.data;
  const userId = request.auth.uid;

  if (!amount || amount <= 0) {
    throw new HttpsError("invalid-argument", "Invalid amount.");
  }

  const db = admin.firestore();

  try {
    await db.runTransaction(async (transaction) => {
      const userRef = db.collection("users").doc(userId);
      
      // Check if payment ID already processed to prevent duplicates
      const paymentRef = db.collection("payments").doc(paymentId);
      const paymentDoc = await transaction.get(paymentRef);
      if (paymentDoc.exists) {
        throw new HttpsError("already-exists", "Payment already processed.");
      }

      // Add Coins
      transaction.update(userRef, {
        fishCoins: admin.firestore.FieldValue.increment(amount)
      });

      // Log Payment
      transaction.set(paymentRef, {
        userId,
        amount,
        status: "success",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // Log Transaction History
      const transRef = db.collection("coin_transactions").doc();
      transaction.set(transRef, {
        userId,
        amount: amount,
        type: "purchase",
        description: `Purchased ${amount} Fish Coins`,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    return { success: true, message: "Coins added successfully!" };
  } catch (error) {
    console.error("Error in topUpWallet:", error);
    throw new HttpsError("internal", "Failed to add coins.");
  }
});
