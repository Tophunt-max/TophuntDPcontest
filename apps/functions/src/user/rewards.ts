import { onCall, HttpsError } from "firebase-functions/v2/https";
import { db, admin } from "../utils/firebase";
import { FieldValue } from "firebase-admin/firestore";

/**
 * Helper to get Reward Settings from DB
 */
async function getRewardSettings() {
  const configDoc = await db.collection("settings").doc("appConfig").get();
  const config = configDoc.data()?.rewardSettings || {};
  return {
    signupBonus: config.signupBonus || 100,
    referralBonus: config.referralBonus || 50,
    dailyBaseReward: config.dailyBaseReward || 10,
    dailyStreakBonus: config.dailyStreakBonus || 2,
    maxDailyReward: config.maxDailyReward || 40,
    voteReward: config.voteReward || 1
  };
}

/**
 * Claim Daily Login Reward & Update Streaks
 */
export const claimDailyReward = onCall(async (request) => {
  const { auth } = request;
  if (!auth) throw new HttpsError("unauthenticated", "User must be logged in.");

  const uid = auth.uid;
  const userRef = db.collection("users").doc(uid);
  const rewardSettings = await getRewardSettings();

  try {
    const result = await db.runTransaction(async (transaction) => {
      const userDoc = await transaction.get(userRef);
      if (!userDoc.exists) throw new HttpsError("not-found", "User not found.");

      const data = userDoc.data()!;
      const now = admin.firestore.Timestamp.now();
      const lastClaimTimestamp = data.lastDailyClaim;

      if (lastClaimTimestamp) {
          const lastClaimDate = lastClaimTimestamp.toDate();
          const currentDate = now.toDate();
          
          if (lastClaimDate.getUTCFullYear() === currentDate.getUTCFullYear() &&
              lastClaimDate.getUTCMonth() === currentDate.getUTCMonth() &&
              lastClaimDate.getUTCDate() === currentDate.getUTCDate()) {
              throw new HttpsError("already-exists", "Daily reward already claimed today.");
          }
      }

      let currentStreak = data.streak || 0;
      
      if (lastClaimTimestamp) {
          const lastClaimDate = lastClaimTimestamp.toDate();
          const yesterday = new Date();
          yesterday.setUTCDate(yesterday.getUTCDate() - 1);

          if (lastClaimDate.getUTCFullYear() === yesterday.getUTCFullYear() &&
              lastClaimDate.getUTCMonth() === yesterday.getUTCMonth() &&
              lastClaimDate.getUTCDate() === yesterday.getUTCDate()) {
              currentStreak += 1;
          } else {
              currentStreak = 1;
          }
      } else {
          currentStreak = 1;
      }

      let coinReward = rewardSettings.dailyBaseReward + (currentStreak * rewardSettings.dailyStreakBonus);
      if (coinReward > rewardSettings.maxDailyReward) {
          coinReward = rewardSettings.maxDailyReward;
      }

      const xpReward = 50;

      transaction.update(userRef, {
        Dpcoin: FieldValue.increment(coinReward),
        xp: FieldValue.increment(xpReward),
        streak: currentStreak,
        lastDailyClaim: now,
      });

      const transRef = db.collection("coinTransactions").doc();
      transaction.set(transRef, {
        uid,
        amount: coinReward,
        type: "daily_reward",
        streak: currentStreak,
        timestamp: now,
        description: `Daily login reward (${currentStreak} day streak)`
      });

      return { 
        success: true, 
        coinsEarned: coinReward, 
        xpEarned: xpReward,
        streak: currentStreak 
      };
    });

    return result;
  } catch (error: any) {
    console.error("claimDailyReward Error:", error);
    if (error instanceof HttpsError) throw error;
    throw new HttpsError("internal", error.message);
  }
});

/**
 * Lucky Spin Reward Handler
 */
export const luckySpin = onCall(async (request) => {
  const { auth } = request;
  const { amount } = request.data;
  
  if (!auth) throw new HttpsError("unauthenticated", "User must be logged in.");
  if (amount === undefined) throw new HttpsError("invalid-argument", "Amount is required.");

  const uid = auth.uid;
  const userRef = db.collection("users").doc(uid);

  try {
    await db.runTransaction(async (transaction) => {
      const userDoc = await transaction.get(userRef);
      if (!userDoc.exists) throw new HttpsError("not-found", "User not found.");

      const now = admin.firestore.Timestamp.now();
      
      // Update User Balance
      transaction.update(userRef, {
        Dpcoin: FieldValue.increment(amount),
        lastSpinAt: now
      });

      // Record transaction
      const transRef = db.collection("coinTransactions").doc();
      transaction.set(transRef, {
        uid,
        amount,
        type: "lucky_spin",
        timestamp: now,
        description: `Lucky spin reward`
      });
    });

    return { success: true, amount };
  } catch (error: any) {
      console.error("luckySpin Error:", error);
      throw new HttpsError("internal", error.message);
  }
});
