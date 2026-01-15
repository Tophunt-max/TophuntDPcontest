import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { db, admin } from "../utils/firebase";
import { FieldValue } from "firebase-admin/firestore";
import { sendPushNotification } from "../notifications/sender";

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
    maxDailyReward: config.maxDailyReward || 40, // Added CAP to prevent economy crash
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

      // Timezone-safe check (Check if last claim was less than 20 hours ago to prevent double claim)
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

          // If last claim was exactly yesterday (UTC), increment streak
          if (lastClaimDate.getUTCFullYear() === yesterday.getUTCFullYear() &&
              lastClaimDate.getUTCMonth() === yesterday.getUTCMonth() &&
              lastClaimDate.getUTCDate() === yesterday.getUTCDate()) {
              currentStreak += 1;
          } else {
              currentStreak = 1; // Streak broken
          }
      } else {
          currentStreak = 1; // First time claim
      }

      // Calculate Reward with CAP
      let coinReward = rewardSettings.dailyBaseReward + (currentStreak * rewardSettings.dailyStreakBonus);
      if (coinReward > rewardSettings.maxDailyReward) {
          coinReward = rewardSettings.maxDailyReward;
      }

      const xpReward = 50;

      transaction.update(userRef, {
        Dpcoin: FieldValue.increment(coinReward), // Standardized field
        xp: FieldValue.increment(xpReward),
        streak: currentStreak,
        lastDailyClaim: now,
      });

      // Record transaction
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
 * Reminds users who haven't claimed their reward today
 */
export const streakReminder = onSchedule("every 24 hours", async (event) => {
  const now = new Date();
  const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  
  // Find users whose last claim was BEFORE today (UTC)
  const usersToRemind = await db.collection("users")
    .where("streak", ">", 0)
    .where("lastDailyClaim", "<", admin.firestore.Timestamp.fromDate(startOfDay))
    .limit(100)
    .get();

  for (const doc of usersToRemind.docs) {
    const data = doc.data();
    await sendPushNotification(
      doc.id,
      "Don't break your streak! 🔥",
      `Come back and claim your daily reward to keep your ${data.streak} day streak alive!`,
      "streak_reminder"
    );
  }
});
