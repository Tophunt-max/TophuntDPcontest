import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";
import { MemoryOption } from "firebase-functions/v2/options";

const ADMIN_WALLET_CONFIG = {
  region: "us-central1", // Cheaper region
  cpu: 1, // Increased to 1
  concurrency: 80,
  memory: "256MiB" as MemoryOption,
  minInstances: 0,
  maxInstances: 2,
  cors: true
};

/**
 * Admin function to add or subtract Fish Coins for a user.
 */
export const adminManageWallet = onCall(ADMIN_WALLET_CONFIG, async (request) => {
  // TODO: Implement robust admin authentication and authorization here.
  // For now, we'll proceed assuming the caller from the admin panel is authorized.
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Admin must be logged in.");
  }

  const adminId = request.auth.uid; // Assign to a local variable after the check

  const { userId, amount, type } = request.data;

  if (!userId || typeof amount !== "number" || amount <= 0 || !["add", "subtract"].includes(type)) {
    throw new HttpsError("invalid-argument", "Invalid request parameters.");
  }

  const db = admin.firestore();
  let newCoinBalance: number = 0; // Initialize outside the transaction

  try {
    await db.runTransaction(async (transaction) => {
      const userRef = db.collection("users").doc(userId);
      const userDoc = await transaction.get(userRef);

      if (!userDoc.exists) {
        throw new HttpsError("not-found", "User not found.");
      }

      const currentCoins = userDoc.data()?.fishCoins || 0;

      if (type === "add") {
        newCoinBalance = currentCoins + amount;
      } else {
        if (currentCoins < amount) {
          throw new HttpsError("failed-precondition", "Not enough coins to subtract.");
        }
        newCoinBalance = currentCoins - amount;
      }

      // Update user's coin balance
      transaction.update(userRef, {
        fishCoins: newCoinBalance,
      });

      // Log Transaction History
      const transRef = db.collection("coin_transactions").doc();
      transaction.set(transRef, {
        userId,
        amount: type === "add" ? amount : -amount,
        type: `admin-${type}`,
        description: `Admin ${type === "add" ? "added" : "subtracted"} ${amount} Fish Coins`,
        adminId: adminId, // Use the local variable here
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    return { success: true, message: `Successfully ${type === "add" ? "added" : "subtracted"} ${amount} coins for user ${userId}.`, newBalance: newCoinBalance };
  } catch (error: any) {
    console.error("Error in adminManageWallet:", error);
    if (error instanceof HttpsError) {
      throw error;
    }
    throw new HttpsError("internal", "Failed to manage user wallet.");
  }
});
