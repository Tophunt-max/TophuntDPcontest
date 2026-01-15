"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.scheduledTasks = void 0;
const firebase_functions_1 = require("firebase-functions");
const firebase_1 = require("../utils/firebase");
const firestore_1 = require("firebase-admin/firestore");
// =================================================================================================
// 🔥 ✅ [COST OPTIMIZATION] CONSOLIDATED CRON JOBS
// =================================================================================================
/**
 * Resolves contests that have ended.
 */
const resolveEndedContests = async () => {
    firebase_functions_1.logger.info("[Scheduled] Checking for ended contests...");
    const now = new Date();
    const query = firebase_1.db.collection("battles").where("status", "==", "active").where("endDate", "<=", now);
    const endedBattles = await query.get();
    if (endedBattles.empty) {
        firebase_functions_1.logger.info("[Scheduled] No ended contests to resolve.");
        return;
    }
    const batch = firebase_1.db.batch();
    for (const battleDoc of endedBattles.docs) {
        const battleData = battleDoc.data();
        let winnerId = null;
        if (battleData.userA.votes > battleData.userB.votes) {
            winnerId = battleData.userA.userId;
        }
        else if (battleData.userB.votes > battleData.userA.userId) {
            winnerId = battleData.userB.userId;
        }
        batch.update(battleDoc.ref, { status: "ended", winnerId });
        if (winnerId) {
            const winnerRef = firebase_1.db.collection("users").doc(winnerId);
            batch.update(winnerRef, { "stats.wins": firestore_1.FieldValue.increment(1) });
        }
    }
    await batch.commit();
    firebase_functions_1.logger.info(`[Scheduled] Resolved ${endedBattles.size} contests.`);
};
/**
 * Cleans up expired stories from the database.
 */
const cleanupExpiredStories = async () => {
    firebase_functions_1.logger.info("[Scheduled] Checking for expired stories...");
    const now = new Date();
    const query = firebase_1.db.collection("stories").where("expiresAt", "<=", now);
    const expiredStories = await query.get();
    if (expiredStories.empty) {
        firebase_functions_1.logger.info("[Scheduled] No expired stories to clean up.");
        return;
    }
    const batch = firebase_1.db.batch();
    expiredStories.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
    firebase_functions_1.logger.info(`[Scheduled] Cleaned up ${expiredStories.size} stories.`);
};
// Master handler for all scheduled tasks
const scheduledTasks = async (event) => {
    firebase_functions_1.logger.info("[Scheduled] Master task handler running.");
    // Run DB tasks
    await resolveEndedContests();
    await cleanupExpiredStories();
    firebase_functions_1.logger.info("[Scheduled] Master task handler finished.");
};
exports.scheduledTasks = scheduledTasks;
//# sourceMappingURL=index.js.map