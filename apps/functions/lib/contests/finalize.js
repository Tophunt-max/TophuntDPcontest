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
const sender_1 = require("../notifications/sender");
const gamification_1 = require("../utils/gamification");
const SCHEDULED_CONFIG = {
    region: "us-central1",
    cpu: 0.25,
    memory: "256MiB",
};
/**
 * Scheduled function to check for ended contest matches and distribute rewards.
 */
exports.finalizeContests = (0, scheduler_1.onSchedule)(Object.assign(Object.assign({}, SCHEDULED_CONFIG), { schedule: "every 1 hours" }), async (event) => {
    const db = admin.firestore();
    const now = admin.firestore.Timestamp.now();
    try {
        // We check 'contestMatches' which are active and expired
        const expiredMatchesSnap = await db.collection("contestMatches")
            .where("status", "==", "active")
            .where("expiresAt", "<=", now)
            .limit(50)
            .get();
        if (expiredMatchesSnap.empty) {
            // Also check for 'waiting' matches that never found an opponent
            const stalledMatchesSnap = await db.collection("contestMatches")
                .where("status", "==", "waiting_for_opponent")
                .where("expiresAt", "<=", now)
                .limit(20)
                .get();
            for (const stalledDoc of stalledMatchesSnap.docs) {
                const data = stalledDoc.data();
                const refundAmount = Number(data.entryFee || 0) / 2;
                const uid = data.userA.uid;
                // Refund Dpcoin to User A
                await db.collection("users").doc(uid).update({
                    Dpcoin: admin.firestore.FieldValue.increment(refundAmount)
                });
                await db.collection("contestMatches").doc(stalledDoc.id).update({ status: "cancelled" });
                await (0, sender_1.sendPushNotification)(uid, "Match Cancelled", "No opponent found. Your Dpcoins have been refunded.", "match_cancelled");
            }
            return;
        }
        for (const matchDoc of expiredMatchesSnap.docs) {
            const matchData = matchDoc.data();
            const contestId = matchData.contestId;
            // Get contest template for reward info
            const contestDoc = await db.collection("contests").doc(contestId).get();
            if (!contestDoc.exists)
                continue;
            const contestData = contestDoc.data();
            let winnerId = null;
            let loserId = null;
            const votesA = matchData.userA.votes || 0;
            const votesB = matchData.userB.votes || 0;
            const minVotes = contestData.minVotes || 0;
            if (votesA > votesB && votesA >= minVotes) {
                winnerId = matchData.userA.uid;
                loserId = matchData.userB.uid;
            }
            else if (votesB > votesA && votesB >= minVotes) {
                winnerId = matchData.userB.uid;
                loserId = matchData.userA.uid;
            }
            const batch = db.batch();
            batch.update(db.collection("contestMatches").doc(matchDoc.id), {
                status: "ended",
                winnerId: winnerId || "none"
            });
            if (winnerId) {
                // Reward is Dpcoin
                const totalPrize = Number(contestData.rewardCoins || contestData.winningCoins || 0);
                const winnerRef = db.collection("users").doc(winnerId);
                batch.update(winnerRef, {
                    Dpcoin: admin.firestore.FieldValue.increment(totalPrize),
                    "stats.wins": admin.firestore.FieldValue.increment(1)
                });
                // Record Transaction
                const transRef = db.collection("coinTransactions").doc();
                batch.set(transRef, {
                    uid: winnerId,
                    amount: totalPrize,
                    type: "win_reward",
                    contestId,
                    matchId: matchDoc.id,
                    description: `Winner reward for ${contestData.title || 'Contest'}`,
                    timestamp: admin.firestore.FieldValue.serverTimestamp(),
                });
                await batch.commit();
                // Gamification
                await (0, gamification_1.awardXp)(winnerId, 500, "battle_win");
                if (loserId)
                    await (0, gamification_1.awardXp)(loserId, 100, "battle_loss");
                // Notifications
                await (0, sender_1.sendPushNotification)(winnerId, "CONGRATULATIONS! 🎉", `You won the battle and earned ${totalPrize} Dpcoins!`, "contest_won");
                if (loserId) {
                    await (0, sender_1.sendPushNotification)(loserId, "Battle Ended 🏁", `The results are in. Better luck next time!`, "contest_lost");
                }
            }
            else {
                // Tie or Min votes not met - Refund partial entry fee
                const entryFeePerUser = Number(matchData.entryFee || 0) / 2;
                if (entryFeePerUser > 0) {
                    batch.update(db.collection("users").doc(matchData.userA.uid), { Dpcoin: admin.firestore.FieldValue.increment(entryFeePerUser) });
                    batch.update(db.collection("users").doc(matchData.userB.uid), { Dpcoin: admin.firestore.FieldValue.increment(entryFeePerUser) });
                }
                await batch.commit();
                await (0, sender_1.sendPushNotification)(matchData.userA.uid, "Contest Ended", "No winner declared. Entry fees refunded.", "contest_ended");
                await (0, sender_1.sendPushNotification)(matchData.userB.uid, "Contest Ended", "No winner declared. Entry fees refunded.", "contest_ended");
            }
        }
    }
    catch (error) {
        console.error("Error finalizing contest matches:", error);
    }
});
//# sourceMappingURL=finalize.js.map