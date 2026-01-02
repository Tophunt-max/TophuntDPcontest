"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.monthlyHallOfFame = exports.resolveContests = void 0;
const scheduler_1 = require("firebase-functions/v2/scheduler");
const firebase_1 = require("../utils/firebase");
const firestore_1 = require("firebase-admin/firestore");
const sender_1 = require("../notifications/sender");
/**
 * AUTOMATED MATCH RESOLVER
 * Runs every 10 minutes to check for finished matches.
 */
exports.resolveContests = (0, scheduler_1.onSchedule)("every 10 minutes", async (event) => {
    const now = firebase_1.admin.firestore.Timestamp.now();
    // 1. Resolve Active Matches that have expired
    const activeMatches = await firebase_1.db.collection("contestMatches")
        .where("status", "==", "active")
        .where("expiresAt", "<=", now)
        .limit(50)
        .get();
    for (const doc of activeMatches.docs) {
        await resolveMatch(doc);
    }
    // 2. Refund User A if no opponent joined (Expired waiting matches)
    const waitingMatches = await firebase_1.db.collection("contestMatches")
        .where("status", "==", "waiting_for_opponent")
        .where("expiresAt", "<=", now)
        .limit(50)
        .get();
    for (const doc of waitingMatches.docs) {
        await refundMatch(doc);
    }
});
/**
 * MONTHLY HALL OF FAME
 * Runs on the 1st of every month to reward Top 3 players.
 */
exports.monthlyHallOfFame = (0, scheduler_1.onSchedule)("0 0 1 * *", async (event) => {
    const usersRef = firebase_1.db.collection("users");
    // Get Top 3 users by monthly wins
    const snapshot = await usersRef
        .orderBy("stats.monthlyWins", "desc")
        .limit(3)
        .get();
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
                coins: firestore_1.FieldValue.increment(reward),
                xp: firestore_1.FieldValue.increment(500),
                badges: firestore_1.FieldValue.arrayUnion(badgeName),
                "stats.monthlyWins": 0 // Reset for the new month
            });
            // Record Transaction
            const transRef = firebase_1.db.collection("coinTransactions").doc();
            transaction.set(transRef, {
                uid: userId,
                amount: reward,
                type: "monthly_hall_of_fame_reward",
                rank: i + 1,
                timestamp: firestore_1.FieldValue.serverTimestamp()
            });
        });
        // Send Winner Notification
        await (0, sender_1.sendPushNotification)(userId, "Monthly Hall of Fame! 🏆", `Congratulations! You ranked #${i + 1} this month. You've earned ${reward} coins and the ${badgeName}!`, "hall_of_fame");
    }
});
/**
 * HELPER: Resolve a specific active match
 */
async function resolveMatch(doc) {
    const data = doc.data();
    const { userA, userB, entryFee, title } = data;
    const matchId = doc.id;
    let winnerUid = "";
    let loserUid = "";
    let rewardAmount = entryFee; // Winner takes all
    if (userA.votes > userB.votes) {
        winnerUid = userA.uid;
        loserUid = userB.uid;
    }
    else if (userB.votes > userA.votes) {
        winnerUid = userB.uid;
        loserUid = userA.uid;
    }
    else {
        // It's a tie
        await refundTieMatch(doc);
        return;
    }
    await firebase_1.db.runTransaction(async (transaction) => {
        // 1. Mark match completed
        transaction.update(doc.ref, {
            status: "completed",
            winnerUid,
            completedAt: firestore_1.FieldValue.serverTimestamp()
        });
        // 2. Award winner
        transaction.update(firebase_1.db.collection("users").doc(winnerUid), {
            coins: firestore_1.FieldValue.increment(rewardAmount),
            xp: firestore_1.FieldValue.increment(100),
            "stats.wins": firestore_1.FieldValue.increment(1),
            "stats.monthlyWins": firestore_1.FieldValue.increment(1)
        });
        // 3. Loser still gets minor XP for participation
        transaction.update(firebase_1.db.collection("users").doc(loserUid), {
            xp: firestore_1.FieldValue.increment(20)
        });
        // 4. Record Transaction
        const transRef = firebase_1.db.collection("coinTransactions").doc();
        transaction.set(transRef, {
            uid: winnerUid,
            amount: rewardAmount,
            type: "contest_win_reward",
            matchId,
            timestamp: firestore_1.FieldValue.serverTimestamp()
        });
    });
    // PUSH NOTIFICATIONS
    await (0, sender_1.sendPushNotification)(winnerUid, "You Won! 🏆", `Victory! You won the battle "${title}" and earned ${rewardAmount} coins!`, "contest_win", { matchId });
    await (0, sender_1.sendPushNotification)(loserUid, "Battle Ended", `The battle "${title}" has concluded. You played well!`, "contest_loss", { matchId });
}
/**
 * HELPER: Refund User A if match never started
 */
async function refundMatch(doc) {
    const data = doc.data();
    const refundAmount = data.entryFee / 2;
    const userId = data.userA.uid;
    await firebase_1.db.runTransaction(async (transaction) => {
        transaction.update(doc.ref, {
            status: "cancelled",
            cancelledReason: "No opponent joined",
            cancelledAt: firestore_1.FieldValue.serverTimestamp()
        });
        transaction.update(firebase_1.db.collection("users").doc(userId), {
            coins: firestore_1.FieldValue.increment(refundAmount)
        });
        const transRef = firebase_1.db.collection("coinTransactions").doc();
        transaction.set(transRef, {
            uid: userId,
            amount: refundAmount,
            type: "contest_refund",
            matchId: doc.id,
            timestamp: firestore_1.FieldValue.serverTimestamp()
        });
    });
    await (0, sender_1.sendPushNotification)(userId, "Contest Refunded", `No opponent joined your "${data.title}" contest. ${refundAmount} coins have been returned.`, "contest_refund");
}
/**
 * HELPER: Handle Ties
 */
async function refundTieMatch(doc) {
    const data = doc.data();
    const refundAmount = data.entryFee / 2;
    await firebase_1.db.runTransaction(async (transaction) => {
        transaction.update(doc.ref, {
            status: "completed",
            result: "tie",
            completedAt: firestore_1.FieldValue.serverTimestamp()
        });
        transaction.update(firebase_1.db.collection("users").doc(data.userA.uid), { coins: firestore_1.FieldValue.increment(refundAmount) });
        transaction.update(firebase_1.db.collection("users").doc(data.userB.uid), { coins: firestore_1.FieldValue.increment(refundAmount) });
    });
    await (0, sender_1.sendPushNotification)(data.userA.uid, "It's a Tie!", "The match ended in a tie. Entry fees refunded.", "contest_tie");
    await (0, sender_1.sendPushNotification)(data.userB.uid, "It's a Tie!", "The match ended in a tie. Entry fees refunded.", "contest_tie");
}
//# sourceMappingURL=cron.js.map