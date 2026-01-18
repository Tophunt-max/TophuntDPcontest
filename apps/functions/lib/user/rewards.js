"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.streakReminder = exports.claimDailyReward = void 0;
const https_1 = require("firebase-functions/v2/https");
const scheduler_1 = require("firebase-functions/v2/scheduler");
const firebase_1 = require("../utils/firebase");
const firestore_1 = require("firebase-admin/firestore");
const sender_1 = require("../notifications/sender");
/**
 * Helper to get Reward Settings from DB
 */
async function getRewardSettings() {
    var _a;
    const configDoc = await firebase_1.db.collection("settings").doc("appConfig").get();
    const config = ((_a = configDoc.data()) === null || _a === void 0 ? void 0 : _a.rewardSettings) || {};
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
exports.claimDailyReward = (0, https_1.onCall)(async (request) => {
    const { auth } = request;
    if (!auth)
        throw new https_1.HttpsError("unauthenticated", "User must be logged in.");
    const uid = auth.uid;
    const userRef = firebase_1.db.collection("users").doc(uid);
    const rewardSettings = await getRewardSettings();
    try {
        const result = await firebase_1.db.runTransaction(async (transaction) => {
            const userDoc = await transaction.get(userRef);
            if (!userDoc.exists)
                throw new https_1.HttpsError("not-found", "User not found.");
            const data = userDoc.data();
            const now = firebase_1.admin.firestore.Timestamp.now();
            const lastClaimTimestamp = data.lastDailyClaim;
            // Timezone-safe check (Check if last claim was less than 20 hours ago to prevent double claim)
            if (lastClaimTimestamp) {
                const lastClaimDate = lastClaimTimestamp.toDate();
                const currentDate = now.toDate();
                if (lastClaimDate.getUTCFullYear() === currentDate.getUTCFullYear() &&
                    lastClaimDate.getUTCMonth() === currentDate.getUTCMonth() &&
                    lastClaimDate.getUTCDate() === currentDate.getUTCDate()) {
                    throw new https_1.HttpsError("already-exists", "Daily reward already claimed today.");
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
                }
                else {
                    currentStreak = 1; // Streak broken
                }
            }
            else {
                currentStreak = 1; // First time claim
            }
            // Calculate Reward with CAP
            let coinReward = rewardSettings.dailyBaseReward + (currentStreak * rewardSettings.dailyStreakBonus);
            if (coinReward > rewardSettings.maxDailyReward) {
                coinReward = rewardSettings.maxDailyReward;
            }
            const xpReward = 50;
            transaction.update(userRef, {
                Dpcoin: firestore_1.FieldValue.increment(coinReward), // Standardized field
                xp: firestore_1.FieldValue.increment(xpReward),
                streak: currentStreak,
                lastDailyClaim: now,
            });
            // Record transaction
            const transRef = firebase_1.db.collection("coinTransactions").doc();
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
    }
    catch (error) {
        console.error("claimDailyReward Error:", error);
        if (error instanceof https_1.HttpsError)
            throw error;
        throw new https_1.HttpsError("internal", error.message);
    }
});
/**
 * Reminds users who haven't claimed their reward today
 */
exports.streakReminder = (0, scheduler_1.onSchedule)("every 24 hours", async (event) => {
    const now = new Date();
    const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    // Find users whose last claim was BEFORE today (UTC)
    const usersToRemind = await firebase_1.db.collection("users")
        .where("streak", ">", 0)
        .where("lastDailyClaim", "<", firebase_1.admin.firestore.Timestamp.fromDate(startOfDay))
        .limit(100)
        .get();
    for (const doc of usersToRemind.docs) {
        const data = doc.data();
        await (0, sender_1.sendPushNotification)(doc.id, "Don't break your streak! 🔥", `Come back and claim your daily reward to keep your ${data.streak} day streak alive!`, "streak_reminder");
    }
});
//# sourceMappingURL=rewards.js.map