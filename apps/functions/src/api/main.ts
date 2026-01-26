import { HttpsError, CallableRequest } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";

// Import Unified Handlers
import { notify as notifyLogic } from "../notifications/handler";
import { storyHandler as storyLogic } from "../stories/index";
import { adminHandler as adminLogic } from "../admin/index";
import { authHandler as authLogic } from "../auth/authHandler";
import { contestHandler as contestLogic } from "../contests/handler";
import { getCallCredentials } from "../webrtc/index";

// Existing Imports (Remaining business logic)
import * as posts from "../posts/index";
import * as userRewards from "../user/rewards";
import * as userSocial from "../user/toggleFollow";
import * as walletTopup from "../wallet/topup";
import { reportContent } from "../user/reporting";
import { claimPrize } from "../user/prizes";

/**
 * MASTER API ROUTER
 * This is the single entry point for all app actions.
 */
export const masterApiRouter = async (request: CallableRequest) => {
    const { action, data } = request.data;
    const uid = request.auth?.uid;

    if (!action) throw new HttpsError("invalid-argument", "Action is required.");

    logger.info(`[Action Called]: ${action} by UID: ${uid || 'Guest'}`);

    try {
        // 1. ROUTE TO UNIFIED HANDLERS
        
        // WebRTC Credentials
        if (action === "getCallCredentials") {
            return await getCallCredentials(request);
        }

        // Contest Handlers
        if (action.startsWith("contest_") || ["join", "vote", "likeContest", "commentContest", "shareContest", "startMatch", "joinMatch", "submitVote"].includes(action)) {
            const contestActionMap: Record<string, string> = {
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
            return await (contestLogic as any).run(request);
        }

        // Notifications
        if (action === "notify") {
            return await (notifyLogic as any).run(request);
        }

        // Stories / Status
        if (action.startsWith("story_") || action === "storyHandler") {
            const storyActionMap: Record<string, string> = {
                "story_create": "create",
                "story_view": "view",
                "story_delete": "delete"
            };
            if (storyActionMap[action]) {
                request.data.action = storyActionMap[action];
            }
            return await (storyLogic as any).run(request);
        }

        // Admin Actions
        if (action.startsWith("admin_") || action === "adminHandler") {
            const adminActionMap: Record<string, string> = {
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
            return await (adminLogic as any).run(request);
        }

        // Auth Actions
        if (action.startsWith("auth_") || action === "authHandler") {
             const authActionMap: Record<string, string> = {
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
            return await (authLogic as any).run(request);
        }

        // 2. LEGACY SWITCHBOARD
        switch (action) {
            case "toggleFollow":
                return await (userSocial.toggleFollow as any).run(request);

            case "claimDailyReward":
                return await (userRewards.claimDailyReward as any).run(request);

            case "luckySpin":
                return await (userRewards.luckySpin as any).run(request);

            case "topup":
                return await (walletTopup.topUpWallet as any).run(request);

            case "createPost":
                return await (posts.createPost as any).run(request);
            case "deletePost":
                return await (posts.deleteUserPost as any).run(request);
            
            case "reportContent":
                return await reportContent(request);

            case "claimPrize":
                return await claimPrize(request);

            // Storage is handled via Cloudflare Workers now
            case "getUploadUrl":
            case "finalizeUpload":
                throw new HttpsError("failed-precondition", "Storage is now handled via Cloudflare Workers.");

            default:
                throw new HttpsError("invalid-argument", `Action '${action}' not found.`);
        }
    } catch (error: any) {
        logger.error(`Error in Master Router [${action}]:`, error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError("internal", error.message || "Internal server error.");
    }
};
