"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.monthlyHallOfFame = exports.resolveContests = void 0;
const scheduler_1 = require("firebase-functions/v2/scheduler");
const firebase_1 = require("../utils/firebase");
const firestore_1 = require("firebase-admin/firestore");
// Removed unused import
// import { sendPushNotification } from "../notifications/sender";
const utils_1 = require("../notifications/utils"); // Import unified notification utility
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
    // 3. (NEW) Send "Ending Soon" Notifications for matches expiring in < 60 minutes
    const oneHourLater = new Date(Date.now() + 60 * 60 * 1000);
    const endingMatches = await firebase_1.db.collection("contestMatches")
        .where("status", "==", "active")
        .where("expiresAt", ">", now)
        .where("expiresAt", "<=", firebase_1.admin.firestore.Timestamp.fromDate(oneHourLater))
        .where("endingSoonNotified", "==", false) // Prevents duplicate notifications
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
    const { userA, userB, title } = data; // Assuming data structure stores user objects or IDs
    // IDs (adjust depending on if userA is object or ID)
    const creatorId = userA.uid || userA;
    const opponentId = userB.uid || userB;
    const message = `⏳ Hurry! The battle "${title || 'Match'}" ends in less than an hour. Get more votes!`;
    // Notify Creator
    if (creatorId) {
        await (0, utils_1.createNotification)(creatorId, {
            title: "Battle Ending Soon!",
            body: message,
            type: "contest-ending",
            targetId: matchId
        });
    }
    // Notify Opponent
    if (opponentId) {
        await (0, utils_1.createNotification)(opponentId, {
            title: "Battle Ending Soon!",
            body: message,
            type: "contest-ending",
            targetId: matchId
        });
    }
    // Mark as notified so we don't spam
    await doc.ref.update({ endingSoonNotified: true });
}
/**
 * HELPER: Resolve a specific active match
 */
async function resolveMatch(doc) {
    const data = doc.data();
    const { userA, userB, entryFee, title, contestId } = data;
    const matchId = doc.id;
    let rewardAmount = Number(entryFee || 0);
    try {
        const contestDoc = await firebase_1.db.collection("contests").doc(contestId).get();
        if (contestDoc.exists) {
            const cData = contestDoc.data();
            rewardAmount = Number(cData.rewardCoins || cData.winningCoins || rewardAmount);
        }
    }
    catch (err) {
        console.error("Error fetching contest reward:", err);
    }
    let winnerUid = "";
    let loserUid = "";
    if (userA.votes > userB.votes) {
        winnerUid = userA.uid;
        loserUid = userB.uid;
    }
    else if (userB.votes > userA.votes) {
        winnerUid = userB.uid;
        loserUid = userA.uid;
    }
    else {
        await refundTieMatch(doc);
        return;
    }
    await firebase_1.db.runTransaction(async (transaction) => {
        const winnerRef = firebase_1.db.collection("users").doc(winnerUid);
        const loserRef = firebase_1.db.collection("users").doc(loserUid);
        const winnerDoc = await transaction.get(winnerRef);
        transaction.update(doc.ref, {
            status: "completed",
            winnerUid,
            rewardAmount,
            completedAt: firestore_1.FieldValue.serverTimestamp()
        });
        const winnerData = winnerDoc.data() || {};
        let coinField = "Dpcoin";
        if (winnerData.Dpcoin === undefined && winnerData.fishCoins !== undefined)
            coinField = "fishCoins";
        else if (winnerData.Dpcoin === undefined && winnerData.coins !== undefined)
            coinField = "coins";
        transaction.update(winnerRef, {
            [coinField]: firestore_1.FieldValue.increment(rewardAmount),
            xp: firestore_1.FieldValue.increment(100),
            "stats.wins": firestore_1.FieldValue.increment(1),
            "stats.monthlyWins": firestore_1.FieldValue.increment(1)
        });
        transaction.update(loserRef, {
            xp: firestore_1.FieldValue.increment(20)
        });
        const transRef = firebase_1.db.collection("coinTransactions").doc();
        transaction.set(transRef, {
            uid: winnerUid,
            amount: rewardAmount,
            type: "contest_win_reward",
            matchId,
            contestId,
            timestamp: firestore_1.FieldValue.serverTimestamp(),
            description: `Victory reward for "${title}"`
        });
    });
    await (0, utils_1.createNotification)(winnerUid, {
        title: "You Won! 🏆",
        body: `Victory! You won the battle "${title}" and earned ${rewardAmount} Dpcoins!`,
        type: "contest-win",
        targetId: matchId
    });
    await (0, utils_1.createNotification)(loserUid, {
        title: "Battle Ended",
        body: `The battle "${title}" has concluded. You played well!`,
        type: "contest-loss",
        targetId: matchId
    });
}
/**
 * HELPER: Refund User A if match never started
 */
async function refundMatch(doc) {
    const data = doc.data();
    const entryFee = Number(data.entryFee || 0);
    const refundAmount = entryFee / 2;
    const userId = data.userA.uid;
    if (refundAmount <= 0)
        return;
    await firebase_1.db.runTransaction(async (transaction) => {
        const userRef = firebase_1.db.collection("users").doc(userId);
        const userDoc = await transaction.get(userRef);
        const userData = userDoc.data() || {};
        let coinField = "Dpcoin";
        if (userData.Dpcoin === undefined && userData.fishCoins !== undefined)
            coinField = "fishCoins";
        else if (userData.Dpcoin === undefined && userData.coins !== undefined)
            coinField = "coins";
        transaction.update(doc.ref, {
            status: "cancelled",
            cancelledReason: "No opponent joined",
            cancelledAt: firestore_1.FieldValue.serverTimestamp()
        });
        transaction.update(userRef, {
            [coinField]: firestore_1.FieldValue.increment(refundAmount)
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
    await (0, utils_1.createNotification)(userId, {
        title: "Contest Refunded",
        body: `No opponent joined your "${data.title}" contest. ${refundAmount} Dpcoins have been returned.`,
        type: "contest-refund",
        targetId: "wallet"
    });
}
/**
 * HELPER: Handle Ties
 */
async function refundTieMatch(doc) {
    const data = doc.data();
    const refundAmount = Number(data.entryFee || 0) / 2;
    if (refundAmount <= 0)
        return;
    await firebase_1.db.runTransaction(async (transaction) => {
        const userARef = firebase_1.db.collection("users").doc(data.userA.uid);
        const userBRef = firebase_1.db.collection("users").doc(data.userB.uid);
        const [userADoc, userBDoc] = await Promise.all([transaction.get(userARef), transaction.get(userBRef)]);
        const uA = userADoc.data() || {};
        const uB = userBDoc.data() || {};
        let fieldA = "Dpcoin";
        if (uA.Dpcoin === undefined && uA.fishCoins !== undefined)
            fieldA = "fishCoins";
        else if (uA.Dpcoin === undefined && uA.coins !== undefined)
            fieldA = "coins";
        let fieldB = "Dpcoin";
        if (uB.Dpcoin === undefined && uB.fishCoins !== undefined)
            fieldB = "fishCoins";
        else if (uB.Dpcoin === undefined && uB.coins !== undefined)
            fieldB = "coins";
        transaction.update(doc.ref, {
            status: "completed",
            result: "tie",
            completedAt: firestore_1.FieldValue.serverTimestamp()
        });
        transaction.update(userARef, { [fieldA]: firestore_1.FieldValue.increment(refundAmount) });
        transaction.update(userBRef, { [fieldB]: firestore_1.FieldValue.increment(refundAmount) });
    });
    await (0, utils_1.createNotification)(data.userA.uid, {
        title: "It's a Tie!",
        body: "The match ended in a tie. Entry fees refunded.",
        type: "contest-tie",
        targetId: "wallet"
    });
    await (0, utils_1.createNotification)(data.userB.uid, {
        title: "It's a Tie!",
        body: "The match ended in a tie. Entry fees refunded.",
        type: "contest-tie",
        targetId: "wallet"
    });
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
            const userData = (await transaction.get(userDoc.ref)).data() || {};
            let coinField = "Dpcoin";
            if (userData.Dpcoin === undefined && userData.fishCoins !== undefined)
                coinField = "fishCoins";
            else if (userData.Dpcoin === undefined && userData.coins !== undefined)
                coinField = "coins";
            transaction.update(userDoc.ref, {
                [coinField]: firestore_1.FieldValue.increment(reward),
                xp: firestore_1.FieldValue.increment(500),
                badges: firestore_1.FieldValue.arrayUnion(badgeName),
                "stats.monthlyWins": 0
            });
            const transRef = firebase_1.db.collection("coinTransactions").doc();
            transaction.set(transRef, {
                uid: userId,
                amount: reward,
                type: "monthly_hall_of_fame_reward",
                rank: i + 1,
                timestamp: firestore_1.FieldValue.serverTimestamp()
            });
        });
        await (0, utils_1.createNotification)(userId, {
            title: "Monthly Hall of Fame! 🏆",
            body: `Congratulations! You ranked #${i + 1} this month. You've earned ${reward} Dpcoins and the ${badgeName}!`,
            type: "hall-of-fame",
            targetId: "profile"
        });
    }
});
//# sourceMappingURL=cron.js.map