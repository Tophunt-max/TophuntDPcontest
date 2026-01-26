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
// Import Unified Handlers
const handler_1 = require("../notifications/handler");
const index_1 = require("../stories/index");
const index_2 = require("../admin/index");
const authHandler_1 = require("../auth/authHandler");
const handler_2 = require("../contests/handler");
const index_3 = require("../webrtc/index");
// Existing Imports (Remaining business logic)
const posts = __importStar(require("../posts/index"));
const userRewards = __importStar(require("../user/rewards"));
const userSocial = __importStar(require("../user/toggleFollow"));
const walletTopup = __importStar(require("../wallet/topup"));
const reporting_1 = require("../user/reporting");
const prizes_1 = require("../user/prizes");
/**
 * MASTER API ROUTER
 * This is the single entry point for all app actions.
 */
const masterApiRouter = async (request) => {
    var _a;
    const { action, data } = request.data;
    const uid = (_a = request.auth) === null || _a === void 0 ? void 0 : _a.uid;
    if (!action)
        throw new https_1.HttpsError("invalid-argument", "Action is required.");
    firebase_functions_1.logger.info(`[Action Called]: ${action} by UID: ${uid || 'Guest'}`);
    try {
        // 1. ROUTE TO UNIFIED HANDLERS
        // WebRTC Credentials
        if (action === "getCallCredentials") {
            return await (0, index_3.getCallCredentials)(request);
        }
        // Contest Handlers
        if (action.startsWith("contest_") || ["join", "vote", "likeContest", "commentContest", "shareContest", "startMatch", "joinMatch", "submitVote"].includes(action)) {
            const contestActionMap = {
                "join": "join",
                "vote": "vote",
                "submitVote": "vote",
                "likeContest": "like",
                "commentContest": "comment",
                "shareContest": "share",
                "startMatch": "startMatch",
                "joinMatch": "joinMatch",
                "contest_createTemplate": "createTemplate"
            };
            if (contestActionMap[action]) {
                request.data.action = contestActionMap[action];
            }
            return await handler_2.contestHandler.run(request);
        }
        // Notifications
        if (action === "notify") {
            return await handler_1.notify.run(request);
        }
        // Stories / Status
        if (action.startsWith("story_") || action === "storyHandler") {
            const storyActionMap = {
                "story_create": "create",
                "story_view": "view",
                "story_delete": "delete"
            };
            if (storyActionMap[action]) {
                request.data.action = storyActionMap[action];
            }
            return await index_1.storyHandler.run(request);
        }
        // Admin Actions
        if (action.startsWith("admin_") || action === "adminHandler") {
            const adminActionMap = {
                "admin_setRole": "setRole",
                "admin_deletePost": "deletePost",
                "admin_unblockUser": "unblockUser",
                "admin_manageWallet": "manageWallet",
                "admin_deleteStory": "deleteStory"
            };
            if (adminActionMap[action]) {
                request.data.action = adminActionMap[action];
                request.data.data = data;
            }
            return await index_2.adminHandler.run(request);
        }
        // Auth Actions
        if (action.startsWith("auth_") || action === "authHandler") {
            const authActionMap = {
                "auth_check": "check",
                "auth_create": "create",
                "auth_createProfile": "createProfile",
                "auth_getUser": "getUserByIdentifier",
                "auth_sendOtp": "sendOtpToPhone",
                "auth_verifyOtp": "verifyOtp",
                "auth_updatePassword": "updatePasswordWithPhone"
            };
            if (authActionMap[action]) {
                request.data.action = authActionMap[action];
            }
            return await authHandler_1.authHandler.run(request);
        }
        // 2. LEGACY SWITCHBOARD
        switch (action) {
            case "toggleFollow":
                return await userSocial.toggleFollow.run(request);
            case "claimDailyReward":
                return await userRewards.claimDailyReward.run(request);
            case "luckySpin":
                return await userRewards.luckySpin.run(request);
            case "topup":
                return await walletTopup.topUpWallet.run(request);
            case "createPost":
                return await posts.createPost.run(request);
            case "deletePost":
                return await posts.deleteUserPost.run(request);
            case "reportContent":
                return await (0, reporting_1.reportContent)(request);
            case "claimPrize":
                return await (0, prizes_1.claimPrize)(request);
            // Storage is handled via Cloudflare Workers now
            case "getUploadUrl":
            case "finalizeUpload":
                throw new https_1.HttpsError("failed-precondition", "Storage is now handled via Cloudflare Workers.");
            default:
                throw new https_1.HttpsError("invalid-argument", `Action '${action}' not found.`);
        }
    }
    catch (error) {
        firebase_functions_1.logger.error(`Error in Master Router [${action}]:`, error);
        if (error instanceof https_1.HttpsError)
            throw error;
        throw new https_1.HttpsError("internal", error.message || "Internal server error.");
    }
};
exports.masterApiRouter = masterApiRouter;
//# sourceMappingURL=main.js.map