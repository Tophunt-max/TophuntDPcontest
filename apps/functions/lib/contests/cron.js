"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.monthlyHallOfFame = exports.contestMaintenance = void 0;
const scheduler_1 = require("firebase-functions/v2/scheduler");
const firebase_1 = require("../utils/firebase");
const firestore_1 = require("firebase-admin/firestore");
const utils_1 = require("../notifications/utils");
const sender_1 = require("../notifications/sender");
/**
 * CONTEST MAINTENANCE CRON
 * Runs every 5 minutes to handle expiration and notifications.
 */
exports.contestMaintenance = (0, scheduler_1.onSchedule)({
    schedule: "every 5 minutes",
    region: "us-central1"
}, async (event) => {
    const now = firebase_1.admin.firestore.Timestamp.now();
    // 1. AUTO-ARCHIVE EXPIRED CONTEST TEMPLATES
    const expiredTemplates = await firebase_1.db.collection("contests")
        .where("status", "==", "live")
        .where("expiresAt", "<", now)
        .limit(20)
        .get();
    for (const doc of expiredTemplates.docs) {
        // Change status to 'ended' so it disappears from mobile app but remains in DB for Admin
        await doc.ref.update({
            status: "ended",
            archivedAt: firestore_1.FieldValue.serverTimestamp()
        });
        console.log(`Archived expired contest template: ${doc.id}`);
    }
    // 2. Send "Ending Soon" Notifications for active matches expiring in < 60 minutes
    const oneHourLater = new Date(Date.now() + 60 * 60 * 1000);
    const endingMatches = await firebase_1.db.collection("contestMatches")
        .where("status", "==", "active")
        .where("endDate", ">", now)
        .where("endDate", "<=", firebase_1.admin.firestore.Timestamp.fromDate(oneHourLater))
        .where("endingSoonNotified", "==", false)
        .limit(50)
        .get();
    for (const doc of endingMatches.docs) {
        await notifyEndingMatch(doc);
    }
});
/**
 * HELPER: Send "Ending Soon" Notification
 */
async function notifyEndingMatch(doc) {
    const data = doc.data();
    const matchId = doc.id;
    const { userA, userB, title } = data;
    const creatorId = userA.uid;
    const opponentId = userB === null || userB === void 0 ? void 0 : userB.uid;
    const message = `⏳ Hurry! The battle "${title || 'Match'}" ends soon. Get more votes to win!`;
    if (creatorId) {
        await (0, utils_1.createNotification)(creatorId, {
            title: "Battle Ending Soon!",
            body: message,
            type: "contest-ending",
            targetId: matchId
        });
        await (0, sender_1.sendPushNotification)(creatorId, "Battle Ending Soon! ⏳", message, "match_ending", { matchId });
    }
    if (opponentId) {
        await (0, utils_1.createNotification)(opponentId, {
            title: "Battle Ending Soon!",
            body: message,
            type: "contest-ending",
            targetId: matchId
        });
        await (0, sender_1.sendPushNotification)(opponentId, "Battle Ending Soon! ⏳", message, "match_ending", { matchId });
    }
    await doc.ref.update({ endingSoonNotified: true });
}
/**
 * MONTHLY HALL OF FAME
 */
exports.monthlyHallOfFame = (0, scheduler_1.onSchedule)("0 0 1 * *", async (event) => {
    const usersRef = firebase_1.db.collection("users");
    const snapshot = await usersRef.orderBy("stats.monthlyWins", "desc").limit(3).get();
    if (snapshot.empty)
        return;
    const rewards = [1000, 500, 250];
    const badges = ["Gold Hall of Fame", "Silver Hall of Fame", "Bronze Hall of Fame"];
    for (let i = 0; i < snapshot.docs.length; i++) {
        const userDoc = snapshot.docs[i];
        const userId = userDoc.id;
        const reward = rewards[i];
        const badgeName = badges[i];
        await firebase_1.db.runTransaction(async (transaction) => {
            transaction.update(userDoc.ref, {
                Dpcoin: firestore_1.FieldValue.increment(reward),
                xp: firestore_1.FieldValue.increment(1000),
                badges: firestore_1.FieldValue.arrayUnion(badgeName),
                "stats.monthlyWins": 0
            });
            const transRef = firebase_1.db.collection("coinTransactions").doc();
            transaction.set(transRef, {
                uid: userId,
                amount: reward,
                type: "monthly_hall_of_fame_reward",
                rank: i + 1,
                timestamp: firestore_1.FieldValue.serverTimestamp(),
                description: `Monthly Hall of Fame Rank #${i + 1} reward`
            });
        });
        const congratMsg = `Congratulations! You ranked #${i + 1} this month. You've earned ${reward} Dpcoins and the ${badgeName}!`;
        await (0, utils_1.createNotification)(userId, {
            title: "Monthly Hall of Fame! 🏆",
            body: congratMsg,
            type: "hall-of-fame",
            targetId: "profile"
        });
        await (0, sender_1.sendPushNotification)(userId, "Monthly Hall of Fame! 🏆", congratMsg, "hall_of_fame", { rank: (i + 1).toString() });
    }
});
//# sourceMappingURL=cron.js.map