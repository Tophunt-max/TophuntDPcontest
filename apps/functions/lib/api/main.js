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
exports.masterApiRouter = void 0;
const https_1 = require("firebase-functions/v2/https");
const firebase_functions_1 = require("firebase-functions");
// Sabhi purane modules ko import kar rahe hain (Auth aur Update actions ko chhod kar)
const contests = __importStar(require("../contests/contestHandler"));
const engagement = __importStar(require("../contests/engagement"));
const matches = __importStar(require("../contests/matchHandler"));
const voting = __importStar(require("../contests/voting"));
const posts = __importStar(require("../posts/index"));
const stories = __importStar(require("../stories/index"));
const userRewards = __importStar(require("../user/rewards"));
const userSocial = __importStar(require("../user/toggleFollow"));
const walletTopup = __importStar(require("../wallet/topup"));
const walletAdmin = __importStar(require("../wallet/adminWalletManagement"));
const adminTools = __importStar(require("../admin/index"));
const notifSender = __importStar(require("../notifications/sender"));
const storage = __importStar(require("../storage/presignedUrl"));
// Special logic
const firebase_1 = require("../utils/firebase");
const firestore_1 = require("firebase-admin/firestore");
const masterApiRouter = async (request) => {
    var _a;
    const { action } = request.data;
    const uid = (_a = request.auth) === null || _a === void 0 ? void 0 : _a.uid;
    if (!action) {
        throw new https_1.HttpsError("invalid-argument", "Action specify karna zaroori hai.");
    }
    firebase_functions_1.logger.info(`[Action Called]: ${action} by UID: ${uid || 'Guest'}`);
    switch (action) {
        // Auth aur User Email/Phone Update ab authHandler se handle hote hain.
        // ================= CONTESTS & MATCHES =================
        case "join":
        case "vote":
            return await contests.contestHandler.run(request);
        case "likeContest":
            return await engagement.likeContest.run(request);
        case "commentContest":
            return await engagement.commentOnContest.run(request);
        case "shareContest":
            return await engagement.shareContest.run(request);
        case "startMatch":
            return await matches.startContestMatch.run(request);
        case "joinMatch":
            return await matches.joinContestMatch.run(request);
        case "submitVote":
            return await voting.submitVote.run(request);
        // ================= POSTS & STORIES =================
        case "createPost":
            return await posts.createPost.run(request);
        case "deletePost":
            return await posts.deleteUserPost.run(request);
        case "createStory":
            return await stories.createStory.run(request);
        case "deleteStory":
            return await stories.deleteStory.run(request);
        case "getStoryUrl":
            return await stories.generateStoryUploadUrl.run(request);
        // ================= USER & SOCIAL =================
        case "toggleFollow":
            return await userSocial.toggleFollow.run(request);
        case "claimDailyReward":
            return await userRewards.claimDailyReward.run(request);
        // sendEmailOtp, verifyEmailOtp, sendPhoneOtp, verifyPhoneOtp are now in authHandler
        // ================= WALLET =================
        case "topup":
            return await walletTopup.topUpWallet.run(request);
        case "adminManageWallet":
            return await walletAdmin.adminManageWallet.run(request);
        // ================= ADMIN TOOLS =================
        case "setAdminRole":
            return await adminTools.setAdminRole.run(request);
        case "adminDeletePost":
            return await adminTools.deletePost.run(request);
        case "unblockUser":
            return await adminTools.unblockUser.run(request);
        case "sendBroadcastNotification":
            return await notifSender.sendBroadcastNotification.run(request);
        // Admin: Contest Creation logic
        case "createContestTemplate":
            if (!uid || !(await (0, firebase_1.isAdmin)(uid)))
                throw new https_1.HttpsError("permission-denied", "Admin only.");
            const contestRef = firebase_1.db.collection("contests").doc();
            await contestRef.set(Object.assign(Object.assign({}, request.data), { status: "live", createdAt: firestore_1.FieldValue.serverTimestamp(), createdBy: uid }));
            return { success: true, contestId: contestRef.id };
        // Admin: Dashboard Stats logic
        case "getAdminStats":
            if (!uid || !(await (0, firebase_1.isAdmin)(uid)))
                throw new https_1.HttpsError("permission-denied", "Admin only.");
            const usersCount = (await firebase_1.db.collection("users").count().get()).data().count;
            const activeMatches = (await firebase_1.db.collection("contestMatches").where("status", "==", "active").count().get()).data().count;
            const waitingMatches = (await firebase_1.db.collection("contestMatches").where("status", "==", "waiting_for_opponent").count().get()).data().count;
            const latestTransactions = await firebase_1.db.collection("coinTransactions").orderBy("timestamp", "desc").limit(10).get();
            return { stats: { usersCount, activeMatches, waitingMatches }, latestTransactions: latestTransactions.docs.map(doc => (Object.assign({ id: doc.id }, doc.data()))) };
        // ================= STORAGE =================
        case "getPresignedUrl":
            return await storage.generatePresignedUrl.run(request);
        default:
            throw new https_1.HttpsError("invalid-argument", `Action '${action}' nahi mila.`);
    }
};
exports.masterApiRouter = masterApiRouter;
//# sourceMappingURL=main.js.map