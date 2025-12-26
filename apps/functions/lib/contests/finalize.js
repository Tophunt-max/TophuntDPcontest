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
/**
 * Scheduled function to check for ended contests and distribute rewards.
 */
exports.finalizeContests = (0, scheduler_1.onSchedule)("every 1 hours", async (event) => {
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
            const votesA = battleData.userA.votes;
            const votesB = battleData.userB.votes;
            if (votesA > votesB && votesA >= contestData.minimumVotes) {
                winnerId = battleData.userA.userId;
                loserId = battleData.userB.userId;
            }
            else if (votesB > votesA && votesB >= contestData.minimumVotes) {
                winnerId = battleData.userB.userId;
                loserId = battleData.userA.userId;
            }
            else {
                // Tie or min votes not met
                loserId = battleData.userA.userId; // Both lose
                const loserB = battleData.userB.userId;
                await (0, sender_1.sendPushNotification)(loserId, "Contest Ended", `No winner in ${contestData.name} (Tied or Min votes not met).`, "contest_ended");
                await (0, sender_1.sendPushNotification)(loserB, "Contest Ended", `No winner in ${contestData.name} (Tied or Min votes not met).`, "contest_ended");
            }
            const batch = db.batch();
            batch.update(db.collection("battles").doc(battleDoc.id), {
                status: "ended",
                winnerId: winnerId || "none"
            });
            if (winnerId) {
                const totalPrize = (contestData.winningCoins || 0) + (contestData.fishCoinsReward || 0);
                batch.update(db.collection("users").doc(winnerId), {
                    fishCoins: admin.firestore.FieldValue.increment(totalPrize),
                    "stats.wins": admin.firestore.FieldValue.increment(1)
                });
                const transRef = db.collection("coin_transactions").doc();
                batch.set(transRef, {
                    userId: winnerId, amount: totalPrize, type: "win_reward", contestId, battleId: battleDoc.id, description: `Winner reward for ${contestData.name}`, createdAt: admin.firestore.FieldValue.serverTimestamp(),
                });
                await batch.commit();
                // NOTIFY WINNER & LOSER
                await (0, sender_1.sendPushNotification)(winnerId, "CONGRATULATIONS! 🎉", `You won the ${contestData.name} contest and earned ${totalPrize} coins!`, "contest_won");
                if (loserId) {
                    await (0, sender_1.sendPushNotification)(loserId, "Battle Ended 🏁", `The results for ${contestData.name} are in. Better luck next time!`, "contest_lost");
                }
            }
            else {
                await batch.commit();
            }
        }
        console.log(`Finalized ${expiredBattlesSnap.size} battles.`);
    }
    catch (error) {
        console.error("Error finalizing:", error);
    }
});
//# sourceMappingURL=finalize.js.map