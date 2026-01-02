"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.streakReminder = exports.claimDailyReward = void 0;
const https_1 = require("firebase-functions/v2/https");
const firebase_1 = require("../utils/firebase");
const firestore_1 = require("firebase-admin/firestore");
const sender_1 = require("../notifications/sender");
/**
 * Claim Daily Login Reward & Update Streaks
 */
exports.claimDailyReward = (0, https_1.onCall)(async (request) => {
    const { auth } = request;
    if (!auth)
        throw new https_1.HttpsError("unauthenticated", "User must be logged in.");
    const uid = auth.uid;
    const userRef = firebase_1.db.collection("users").doc(uid);
    return await firebase_1.db.runTransaction(async (transaction) => {
        var _a;
        const userDoc = await transaction.get(userRef);
        if (!userDoc.exists)
            throw new https_1.HttpsError("not-found", "User not found.");
        const data = userDoc.data();
        const now = new Date();
        const lastClaim = (_a = data.lastDailyClaim) === null || _a === void 0 ? void 0 : _a.toDate();
        // Check if already claimed today
        if (lastClaim && lastClaim.toDateString() === now.toDateString()) {
            throw new https_1.HttpsError("already-exists", "Daily reward already claimed today.");
        }
        let currentStreak = data.streak || 0;
        const yesterday = new Date();
        yesterday.setDate(now.getDate() - 1);
        // Reset streak if last claim was not yesterday
        if (!lastClaim || lastClaim.toDateString() !== yesterday.toDateString()) {
            currentStreak = 1;
        }
        else {
            currentStreak += 1;
        }
        // Base reward: 10 coins + (Streak * 2 bonus)
        const coinReward = 10 + (currentStreak * 2);
        const xpReward = 50;
        transaction.update(userRef, {
            coins: firestore_1.FieldValue.increment(coinReward),
            xp: firestore_1.FieldValue.increment(xpReward),
            streak: currentStreak,
            lastDailyClaim: firestore_1.FieldValue.serverTimestamp(),
        });
        // Record Transaction
        const transRef = firebase_1.db.collection("coinTransactions").doc();
        transaction.set(transRef, {
            uid,
            amount: coinReward,
            type: "daily_reward",
            streak: currentStreak,
            timestamp: firestore_1.FieldValue.serverTimestamp()
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
 * Runs daily to remind users whose streak is about to break
 */
const scheduler_1 = require("firebase-functions/v2/scheduler");
exports.streakReminder = (0, scheduler_1.onSchedule)("every 24 hours", async (event) => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    // Find users who claimed yesterday but NOT today yet
    const usersToRemind = await firebase_1.db.collection("users")
        .where("streak", ">", 0)
        .where("lastDailyClaim", "<=", firebase_1.admin.firestore.Timestamp.fromDate(yesterday))
        .limit(100)
        .get();
    for (const doc of usersToRemind.docs) {
        await (0, sender_1.sendPushNotification)(doc.id, "Don't break your streak! 🔥", `Come back and claim your daily reward to keep your ${doc.data().streak} day streak alive!`, "streak_reminder");
    }
});
//# sourceMappingURL=rewards.js.map