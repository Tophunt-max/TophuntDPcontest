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
// Imports
const contests = __importStar(require("../contests/contestHandler"));
const engagement = __importStar(require("../contests/engagement"));
const matches = __importStar(require("../contests/matchHandler"));
const posts = __importStar(require("../posts/index"));
const stories = __importStar(require("../stories/index"));
const userRewards = __importStar(require("../user/rewards"));
const userSocial = __importStar(require("../user/toggleFollow"));
const walletTopup = __importStar(require("../wallet/topup"));
const walletAdmin = __importStar(require("../wallet/adminWalletManagement"));
const adminTools = __importStar(require("../admin/index"));
const storageApi_1 = require("./storageApi"); // UPDATED IMPORT
const notificationApi_1 = require("./notificationApi");
const masterApiRouter = async (request) => {
    var _a;
    const { action } = request.data;
    const uid = (_a = request.auth) === null || _a === void 0 ? void 0 : _a.uid;
    if (!action)
        throw new https_1.HttpsError("invalid-argument", "Action specify karna zaroori hai.");
    firebase_functions_1.logger.info(`[Action Called]: ${action} by UID: ${uid || 'Guest'}`);
    let response;
    switch (action) {
        // ================= CONTESTS & MATCHES =================
        case "join":
        case "vote":
        case "createContestTemplate": // ADDED
            response = await contests.contestHandler.run(request);
            break;
        case "likeContest":
            response = await engagement.likeContest.run(request);
            if (uid && request.data.matchId) {
                await (0, notificationApi_1.notificationApiRouter)(Object.assign(Object.assign({}, request), { data: { type: "LIKE", data: { targetId: request.data.matchId, targetType: "match", likerId: uid, authorId: response.authorId } } }));
            }
            break;
        case "commentContest":
            response = await engagement.commentOnContest.run(request);
            if (uid && request.data.matchId) {
                await (0, notificationApi_1.notificationApiRouter)(Object.assign(Object.assign({}, request), { data: { type: "COMMENT", data: { targetId: request.data.matchId, commenterId: uid, text: request.data.text, authorId: response.authorId } } }));
            }
            break;
        case "startMatch":
            response = await matches.startContestMatch.run(request);
            if (uid && request.data.opponentId) {
                await (0, notificationApi_1.notificationApiRouter)(Object.assign(Object.assign({}, request), { data: { type: "BATTLE", data: { action: "CHALLENGE", matchId: response.matchId, senderId: uid, receiverId: request.data.opponentId } } }));
            }
            break;
        case "joinMatch":
            response = await matches.joinContestMatch.run(request);
            if (uid && response.creatorId) {
                await (0, notificationApi_1.notificationApiRouter)(Object.assign(Object.assign({}, request), { data: { type: "BATTLE", data: { action: "ACCEPTED", matchId: request.data.matchId, senderId: uid, receiverId: response.creatorId } } }));
            }
            break;
        // ================= USER & SOCIAL =================
        case "toggleFollow":
            response = await userSocial.toggleFollow.run(request);
            if (response.isFollowing && uid && request.data.targetUserId) {
                await (0, notificationApi_1.notificationApiRouter)(Object.assign(Object.assign({}, request), { data: { type: "FOLLOW", data: { targetUserId: request.data.targetUserId, followerId: uid } } }));
            }
            break;
        case "claimDailyReward":
            response = await userRewards.claimDailyReward.run(request);
            if (uid) {
                await (0, notificationApi_1.notificationApiRouter)(Object.assign(Object.assign({}, request), { data: { type: "WALLET", data: { userId: uid, amount: response.rewardAmount, transactionType: "daily_reward" } } }));
            }
            break;
        // ================= WALLET =================
        case "topup":
            response = await walletTopup.topUpWallet.run(request);
            if (uid) {
                await (0, notificationApi_1.notificationApiRouter)(Object.assign(Object.assign({}, request), { data: { type: "WALLET", data: { userId: uid, amount: request.data.amount, transactionType: "topup" } } }));
            }
            break;
        // ================= STORAGE (UPDATED) =================
        case "uploadDirect": // ADDED
        case "getPresignedUrl":
        case "getUploadUrl":
        case "deleteFile":
        case "startMultipart":
        case "getPartUrls":
        case "completeMultipart":
        case "finalizeUpload":
            return await (0, storageApi_1.storageApi)(request);
        // ================= FALLBACK =================
        default:
            const actions = {
                "createPost": posts.createPost,
                "deletePost": posts.deleteUserPost,
                "storyHandler": stories.storyHandler,
                "setAdminRole": adminTools.setAdminRole,
                "adminDeletePost": adminTools.deletePost,
                "unblockUser": adminTools.unblockUser,
                "adminManageWallet": walletAdmin.adminManageWallet
            };
            if (actions[action]) {
                return await actions[action].run(request);
            }
            throw new https_1.HttpsError("invalid-argument", `Action '${action}' nahi mila.`);
    }
    return response;
};
exports.masterApiRouter = masterApiRouter;
//# sourceMappingURL=main.js.map