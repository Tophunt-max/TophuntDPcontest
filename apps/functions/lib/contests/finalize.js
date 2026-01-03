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
 * Scheduled function to check for ended contests and distribute rewards.
 */
exports.finalizeContests = (0, scheduler_1.onSchedule)(Object.assign(Object.assign({}, SCHEDULED_CONFIG), { schedule: "every 1 hours" }), async (event) => {
    const db = admin.firestore();
    const now = admin.firestore.Timestamp.now();
    try {
        const expiredBattlesSnap = await db.collection("battles")
            .where("status", "==", "active")
            .where("endDate", "<=", now)
            .limit(50)
            .get();
        if (expiredBattlesSnap.empty)
            return;
        for (const battleDoc of expiredBattlesSnap.docs) {
            const battleData = battleDoc.data();
            const contestId = battleData.contestId;
            const contestDoc = await db.collection("contests").doc(contestId).get();
            if (!contestDoc.exists)
                continue;
            const contestData = contestDoc.data();
            let winnerId = null;
            let loserId = null;
            let loserId2 = null;
            const votesA = battleData.userA.votes;
            const votesB = battleData.userB.votes;
            const minVotes = contestData.minimumVotes || contestData.minVotes || 0;
            if (votesA > votesB && votesA >= minVotes) {
                winnerId = battleData.userA.userId;
                loserId = battleData.userB.userId;
            }
            else if (votesB > votesA && votesB >= minVotes) {
                winnerId = battleData.userB.userId;
                loserId = battleData.userA.userId;
            }
            else {
                loserId = battleData.userA.userId;
                loserId2 = battleData.userB.userId;
            }
            const batch = db.batch();
            batch.update(db.collection("battles").doc(battleDoc.id), {
                status: "ended",
                winnerId: winnerId || "none"
            });
            if (winnerId) {
                // Use rewardCoins from template (Priority)
                const totalPrize = Number(contestData.rewardCoins || contestData.winningCoins || contestData.fishCoinsReward || contestData.DpcoinReward || 0);
                const winnerRef = db.collection("users").doc(winnerId);
                const winnerDoc = await winnerRef.get();
                const winnerData = winnerDoc.data() || {};
                let coinField = "Dpcoin";
                if (winnerData.Dpcoin === undefined && winnerData.fishCoins !== undefined)
                    coinField = "fishCoins";
                else if (winnerData.Dpcoin === undefined && winnerData.coins !== undefined)
                    coinField = "coins";
                // Update Winner Coins & Stats
                batch.update(winnerRef, {
                    [coinField]: admin.firestore.FieldValue.increment(totalPrize),
                    "stats.wins": admin.firestore.FieldValue.increment(1)
                });
                // Record Transaction
                const transRef = db.collection("coinTransactions").doc();
                batch.set(transRef, {
                    uid: winnerId,
                    amount: totalPrize,
                    type: "win_reward",
                    contestId,
                    battleId: battleDoc.id,
                    description: `Winner reward for ${contestData.name}`,
                    timestamp: admin.firestore.FieldValue.serverTimestamp(),
                });
                await batch.commit();
                // Gamification: Award XP
                await (0, gamification_1.awardXp)(winnerId, 500, "battle_win");
                if (loserId)
                    await (0, gamification_1.awardXp)(loserId, 100, "battle_loss");
                // NOTIFICATIONS
                await (0, sender_1.sendPushNotification)(winnerId, "CONGRATULATIONS! 🎉", `You won the ${contestData.name} contest and earned ${totalPrize} Dpcoins!`, "contest_won");
                if (loserId) {
                    await (0, sender_1.sendPushNotification)(loserId, "Battle Ended 🏁", `The results for ${contestData.name} are in. Better luck next time! (+100 XP)`, "contest_lost");
                }
            }
            else {
                // No winner (Tie or Min votes not met)
                const entryFee = Number(battleData.entryFee || 0);
                if (entryFee > 0) {
                    const refundAmount = entryFee / 2;
                    const userARef = db.collection("users").doc(battleData.userA.userId);
                    const userBRef = db.collection("users").doc(battleData.userB.userId);
                    // Refund using Dpcoin logic or whatever exists
                    batch.update(userARef, { Dpcoin: admin.firestore.FieldValue.increment(refundAmount) });
                    batch.update(userBRef, { Dpcoin: admin.firestore.FieldValue.increment(refundAmount) });
                }
                await batch.commit();
                if (loserId)
                    await (0, gamification_1.awardXp)(loserId, 50, "battle_tie");
                if (loserId2)
                    await (0, gamification_1.awardXp)(loserId2, 50, "battle_tie");
                if (loserId)
                    await (0, sender_1.sendPushNotification)(loserId, "Contest Ended", `No winner in ${contestData.name}. Fees refunded if applicable. (+50 XP)`, "contest_ended");
                if (loserId2)
                    await (0, sender_1.sendPushNotification)(loserId2, "Contest Ended", `No winner in ${contestData.name}. Fees refunded if applicable. (+50 XP)`, "contest_ended");
            }
        }
    }
    catch (error) {
        console.error("Error finalizing:", error);
    }
});
//# sourceMappingURL=finalize.js.map