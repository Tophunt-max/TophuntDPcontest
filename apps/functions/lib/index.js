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
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAdminStats = exports.createContestTemplate = void 0;
const firebase_1 = require("./utils/firebase");
const https_1 = require("firebase-functions/v2/https");
const firestore_1 = require("firebase-admin/firestore");
const v2_1 = require("firebase-functions/v2");
// OPTIMIZED GLOBAL OPTIONS FOR QUOTA MANAGEMENT
// Concurrency requires at least 1 CPU.
(0, v2_1.setGlobalOptions)({
    region: 'us-central1',
    cpu: 1, // Must be >= 1 for concurrency
    memory: '256MiB',
    maxInstances: 1, // Strict limit to prevent quota explosion
    concurrency: 80 // Allow up to 80 requests per instance
});
// --- EXPORT ALL MODULES ---
// 1. Auth & User Profile
__exportStar(require("./auth/authHandler"), exports);
__exportStar(require("./user/emailUpdate"), exports);
__exportStar(require("./user/phoneUpdate"), exports);
__exportStar(require("./user/toggleFollow"), exports);
__exportStar(require("./user/rewards"), exports);
// 2. Contests, Matches & Voting
__exportStar(require("./contests/matchHandler"), exports);
__exportStar(require("./contests/voting"), exports);
__exportStar(require("./contests/cron"), exports);
__exportStar(require("./contests/contestHandler"), exports);
// 3. Posts & Stories
__exportStar(require("./posts/index"), exports);
__exportStar(require("./stories/index"), exports);
// 4. Wallet & Payments
__exportStar(require("./wallet/topup"), exports);
__exportStar(require("./wallet/adminWalletManagement"), exports);
// 5. Notifications & Messaging
__exportStar(require("./notifications/index"), exports);
__exportStar(require("./admin/notifications"), exports);
// 6. Admin Tools
__exportStar(require("./admin/index"), exports);
// 7. Storage & Utilities
__exportStar(require("./storage/presignedUrl"), exports);
// --- INLINE FUNCTIONS (Existing in index.ts) ---
/**
 * ADMIN: Create a new Contest Template
 */
exports.createContestTemplate = (0, https_1.onCall)(async (request) => {
    if (!request.auth)
        throw new https_1.HttpsError("unauthenticated", "Auth required.");
    const isUserAdmin = await (0, firebase_1.isAdmin)(request.auth.uid);
    if (!isUserAdmin)
        throw new https_1.HttpsError("permission-denied", "Admin only.");
    const data = request.data;
    const contestRef = firebase_1.db.collection("contests").doc();
    await contestRef.set(Object.assign(Object.assign({}, data), { status: "live", createdAt: firestore_1.FieldValue.serverTimestamp(), createdBy: request.auth.uid }));
    return { success: true, contestId: contestRef.id };
});
/**
 * ADMIN: God View Dashboard Stats
 */
exports.getAdminStats = (0, https_1.onCall)(async (request) => {
    if (!request.auth || !(await (0, firebase_1.isAdmin)(request.auth.uid))) {
        throw new https_1.HttpsError("permission-denied", "Admin only.");
    }
    const usersCount = (await firebase_1.db.collection("users").count().get()).data().count;
    const activeMatches = (await firebase_1.db.collection("contestMatches").where("status", "==", "active").count().get()).data().count;
    const waitingMatches = (await firebase_1.db.collection("contestMatches").where("status", "==", "waiting_for_opponent").count().get()).data().count;
    const latestTransactions = await firebase_1.db.collection("coinTransactions")
        .orderBy("timestamp", "desc")
        .limit(10)
        .get();
    return {
        stats: { usersCount, activeMatches, waitingMatches },
        latestTransactions: latestTransactions.docs.map(doc => (Object.assign({ id: doc.id }, doc.data())))
    };
});
//# sourceMappingURL=index.js.map