import { onCall, HttpsError } from "firebase-functions/v2/https";
import { db, admin } from "../utils/firebase";
import { FieldValue } from "firebase-admin/firestore";
import { sendPushNotification } from "../notifications/sender";

/**
 * Claim Daily Login Reward & Update Streaks
 */
export const claimDailyReward = onCall(async (request) => {
  const { auth } = request;
  if (!auth) throw new HttpsError("unauthenticated", "User must be logged in.");

  const uid = auth.uid;
  const userRef = db.collection("users").doc(uid);

  return await db.runTransaction(async (transaction) => {
    const userDoc = await transaction.get(userRef);
    if (!userDoc.exists) throw new HttpsError("not-found", "User not found.");

    const data = userDoc.data()!;
    const now = new Date();
    const lastClaim = data.lastDailyClaim?.toDate();

    // Check if already claimed today
    if (lastClaim && lastClaim.toDateString() === now.toDateString()) {
      throw new HttpsError("already-exists", "Daily reward already claimed today.");
    }

    let currentStreak = data.streak || 0;
    const yesterday = new Date();
    yesterday.setDate(now.getDate() - 1);

    // Reset streak if last claim was not yesterday
    if (!lastClaim || lastClaim.toDateString() !== yesterday.toDateString()) {
      currentStreak = 1;
    } else {
      currentStreak += 1;
    }

    // Base reward: 10 Dpcoins + (Streak * 2 bonus)
    const coinReward = 10 + (currentStreak * 2);
    const xpReward = 50;

    // Use Dpcoin field primarily
    let coinField = "Dpcoin";
    if (data.Dpcoin === undefined && data.fishCoins !== undefined) coinField = "fishCoins";
    else if (data.Dpcoin === undefined && data.coins !== undefined) coinField = "coins";

    transaction.update(userRef, {
      [coinField]: FieldValue.increment(coinReward),
      xp: FieldValue.increment(xpReward),
      streak: currentStreak,
      lastDailyClaim: FieldValue.serverTimestamp(),
    });

    // Record Transaction
    const transRef = db.collection("coinTransactions").doc();
    transaction.set(transRef, {
      uid,
      amount: coinReward,
      type: "daily_reward",
      streak: currentStreak,
      timestamp: FieldValue.serverTimestamp(),
      description: `Daily login reward (${currentStreak} day streak)`
    });

    return { 
      success: true, 
      coinsEarned: coinReward, 
      xpEarned: xpReward,
      streak: currentStreak 
    };
  });
});

/**
 * Check Streaks & Send Reminders (Cron Job)
 */
import { onSchedule } from "firebase-functions/v2/scheduler";

export const streakReminder = onSchedule("every 24 hours", async (event) => {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  
  const usersToRemind = await db.collection("users")
    .where("streak", ">", 0)
    .where("lastDailyClaim", "<=", admin.firestore.Timestamp.fromDate(yesterday))
    .limit(100)
    .get();

  for (const doc of usersToRemind.docs) {
    await sendPushNotification(
      doc.id,
      "Don't break your streak! 🔥",
      `Come back and claim your daily reward to keep your ${doc.data().streak} day streak alive!`,
      "streak_reminder"
    );
  }
});
