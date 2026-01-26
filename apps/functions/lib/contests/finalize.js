"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.finalizeContests = void 0;
const scheduler_1 = require("firebase-functions/v2/scheduler");
const admin = __importStar(require("firebase-admin"));
const utils_1 = require("../notifications/utils");
const sender_1 = require("../notifications/sender");
const SCHEDULED_CONFIG = {
    region: "us-central1",
    cpu: 0.25,
    memory: "256MiB",
};
/**
 * PRODUCTION-GRADE CONTEST FINALIZER
 * Checks for ended contest matches, determines winners, distributes rewards and updates user stats.
 */
exports.finalizeContests = (0, scheduler_1.onSchedule)(Object.assign(Object.assign({}, SCHEDULED_CONFIG), { schedule: "every 15 minutes" }), async (event) => {
    const db = admin.firestore();
    const now = admin.firestore.Timestamp.now();
    try {
        // 0. EXPIRE CONTEST TEMPLATES
        const expiredTemplatesSnap = await db.collection("contests")
            .where("status", "==", "live")
            .where("expiresAt", "<=", now)
            .limit(20)
            .get();
        for (const templateDoc of expiredTemplatesSnap.docs) {
            await templateDoc.ref.update({ status: "expired", updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        }
        // 1. REFUND STALLED MATCHES (Waiting for too long)
        const stalledMatchesSnap = await db.collection("contestMatches")
            .where("status", "==", "waiting_for_opponent")
            .where("expiresAt", "<=", now)
            .limit(20)
            .get();
        for (const stalledDoc of stalledMatchesSnap.docs) {
            try {
                const data = stalledDoc.data();
                const refundAmount = Math.ceil(Number(data.entryFee || 0) / 2);
                const uid = data.userA.uid;
                await db.runTransaction(async (transaction) => {
                    const userRef = db.collection("users").doc(uid);
                    transaction.update(userRef, {
                        Dpcoin: admin.firestore.FieldValue.increment(refundAmount)
                    });
                    transaction.update(stalledDoc.ref, { status: "cancelled", updatedAt: admin.firestore.FieldValue.serverTimestamp() });
                    const transRef = db.collection("coinTransactions").doc();
                    transaction.set(transRef, {
                        uid, amount: refundAmount, type: "contest_refund", matchId: stalledDoc.id,
                        description: "Refund: No opponent found.", timestamp: admin.firestore.FieldValue.serverTimestamp()
                    });
                });
                const refundMsg = "No opponent found. Your Dpcoins have been refunded.";
                await (0, utils_1.createNotification)(uid, { title: "Match Cancelled", body: refundMsg, type: "contest", targetId: stalledDoc.id });
                await (0, sender_1.sendPushNotification)(uid, "Match Cancelled ❌", refundMsg, "match_refund", { matchId: stalledDoc.id });
            }
            catch (e) {
                console.error(`Error refunding stalled match ${stalledDoc.id}:`, e);
            }
        }
        // 2. FINALIZE ACTIVE MATCHES (Battle Ended)
        const expiredMatchesSnap = await db.collection("contestMatches")
            .where("status", "==", "active")
            .where("endDate", "<=", now)
            .limit(30)
            .get();
        for (const matchDoc of expiredMatchesSnap.docs) {
            try {
                const matchData = matchDoc.data();
                const contestId = matchData.contestId;
                const contestDoc = await db.collection("contests").doc(contestId).get();
                if (!contestDoc.exists) {
                    await matchDoc.ref.update({ status: "ended", winnerId: "none", updatedAt: admin.firestore.FieldValue.serverTimestamp() });
                    continue;
                }
                const contestData = contestDoc.data();
                const votesA = matchData.userA.votes || 0;
                const votesB = matchData.userB.votes || 0;
                const minVotes = Number(contestData.minVotes || 0);
                let winnerId = null;
                let loserId = null;
                if (votesA > votesB && votesA >= minVotes) {
                    winnerId = matchData.userA.uid;
                    loserId = matchData.userB.uid;
                }
                else if (votesB > votesA && votesB >= minVotes) {
                    winnerId = matchData.userB.uid;
                    loserId = matchData.userA.uid;
                }
                const coinReward = Number(contestData.winnerReward || contestData.rewardCoins || 0);
                const rewardType = contestData.rewardType || 'coin';
                const prizeName = contestData.prizeDescription || "";
                await db.runTransaction(async (transaction) => {
                    const userARef = db.collection("users").doc(matchData.userA.uid);
                    const userBRef = db.collection("users").doc(matchData.userB.uid);
                    transaction.update(userARef, { "stats.totalVotesReceived": admin.firestore.FieldValue.increment(votesA) });
                    transaction.update(userBRef, { "stats.totalVotesReceived": admin.firestore.FieldValue.increment(votesB) });
                    if (winnerId) {
                        const winnerRef = db.collection("users").doc(winnerId);
                        const loserRef = db.collection("users").doc(loserId);
                        transaction.update(matchDoc.ref, {
                            status: "ended",
                            winnerId,
                            rewardType,
                            prizeDescription: prizeName,
                            isPrizeClaimed: false,
                            winnerReward: coinReward,
                            updatedAt: admin.firestore.FieldValue.serverTimestamp()
                        });
                        if (coinReward > 0 && (rewardType === 'coin' || rewardType === 'both')) {
                            transaction.update(winnerRef, {
                                Dpcoin: admin.firestore.FieldValue.increment(coinReward)
                            });
                            const transRef = db.collection("coinTransactions").doc();
                            transaction.set(transRef, {
                                uid: winnerId, amount: coinReward, type: "win_reward",
                                contestId, matchId: matchDoc.id,
                                description: `Winner reward for ${contestData.title}`,
                                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                            });
                        }
                        transaction.update(winnerRef, {
                            "stats.wins": admin.firestore.FieldValue.increment(1),
                            xp: admin.firestore.FieldValue.increment(500)
                        });
                        transaction.update(loserRef, { xp: admin.firestore.FieldValue.increment(100) });
                    }
                    else {
                        const refundAmount = Math.ceil(Number(matchData.entryFee || 0) / 2);
                        transaction.update(matchDoc.ref, { status: "ended", winnerId: "draw", updatedAt: admin.firestore.FieldValue.serverTimestamp() });
                        if (refundAmount > 0) {
                            transaction.update(userARef, { Dpcoin: admin.firestore.FieldValue.increment(refundAmount) });
                            transaction.update(userBRef, { Dpcoin: admin.firestore.FieldValue.increment(refundAmount) });
                        }
                    }
                });
                if (winnerId) {
                    let winTitle = "CONGRATULATIONS! 🎉";
                    let winBody = `You won the battle "${contestData.title}"!`;
                    if (rewardType === 'product')
                        winBody = `You won: ${prizeName}! Claim it now in your profile.`;
                    else if (rewardType === 'both')
                        winBody = `You won: ${prizeName} + ${coinReward} Dpcoins!`;
                    else
                        winBody = `You won ${coinReward} Dpcoins!`;
                    await (0, utils_1.createNotification)(winnerId, { title: winTitle, body: winBody, type: "contest", targetId: matchDoc.id });
                    await (0, sender_1.sendPushNotification)(winnerId, winTitle, winBody, "match_winner", { matchId: matchDoc.id });
                    if (loserId) {
                        await (0, sender_1.sendPushNotification)(loserId, "Battle Ended 🏁", `The results are in for "${contestData.title}". Better luck next time!`, "match_loser", { matchId: matchDoc.id });
                    }
                }
                else {
                    const drawMsg = votesA === votesB ? "It was a draw!" : "Minimum votes not met.";
                    for (const id of [matchData.userA.uid, matchData.userB.uid]) {
                        await (0, sender_1.sendPushNotification)(id, "Battle Ended 🏁", `${drawMsg} Entry fees refunded.`, "match_draw", { matchId: matchDoc.id });
                    }
                }
            }
            catch (e) {
                console.error(`Error finalizing match ${matchDoc.id}:`, e);
            }
        }
    }
    catch (error) {
        console.error("Master error in finalizeContests:", error);
    }
});
//# sourceMappingURL=finalize.js.map