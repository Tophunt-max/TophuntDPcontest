import { HttpsError, CallableRequest } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";

// Imports
import * as contests from "../contests/contestHandler";
import * as engagement from "../contests/engagement";
import * as matches from "../contests/matchHandler";
import * as posts from "../posts/index";
import * as stories from "../stories/index";
import * as userRewards from "../user/rewards";
import * as userSocial from "../user/toggleFollow";
import * as walletTopup from "../wallet/topup";
import * as walletAdmin from "../wallet/adminWalletManagement";
import * as adminTools from "../admin/index";
import { storageApi } from "./storageApi"; // UPDATED IMPORT
import { notificationApiRouter } from "./notificationApi";

export const masterApiRouter = async (request: CallableRequest) => {
  const { action } = request.data;
  const uid = request.auth?.uid;

  if (!action) throw new HttpsError("invalid-argument", "Action specify karna zaroori hai.");

  logger.info(`[Action Called]: ${action} by UID: ${uid || 'Guest'}`);

  let response: any;

  switch (action) {
    // ================= CONTESTS & MATCHES =================
    case "join":
    case "vote":
    case "createContestTemplate": // ADDED
      response = await (contests.contestHandler as any).run(request);
      break;
    case "likeContest":
      response = await (engagement.likeContest as any).run(request);
      if (uid && request.data.matchId) {
        await notificationApiRouter({ ...request, data: { type: "LIKE", data: { targetId: request.data.matchId, targetType: "match", likerId: uid, authorId: response.authorId } } } as any);
      }
      break;
    case "commentContest":
      response = await (engagement.commentOnContest as any).run(request);
      if (uid && request.data.matchId) {
        await notificationApiRouter({ ...request, data: { type: "COMMENT", data: { targetId: request.data.matchId, commenterId: uid, text: request.data.text, authorId: response.authorId } } } as any);
      }
      break;
    case "startMatch":
      response = await (matches.startContestMatch as any).run(request);
      if (uid && request.data.opponentId) {
        await notificationApiRouter({ ...request, data: { type: "BATTLE", data: { action: "CHALLENGE", matchId: response.matchId, senderId: uid, receiverId: request.data.opponentId } } } as any);
      }
      break;
    case "joinMatch":
      response = await (matches.joinContestMatch as any).run(request);
      if (uid && response.creatorId) {
        await notificationApiRouter({ ...request, data: { type: "BATTLE", data: { action: "ACCEPTED", matchId: request.data.matchId, senderId: uid, receiverId: response.creatorId } } } as any);
      }
      break;

    // ================= USER & SOCIAL =================
    case "toggleFollow":
      response = await (userSocial.toggleFollow as any).run(request);
      if (response.isFollowing && uid && request.data.targetUserId) {
        await notificationApiRouter({ ...request, data: { type: "FOLLOW", data: { targetUserId: request.data.targetUserId, followerId: uid } } } as any);
      }
      break;
    case "claimDailyReward":
      response = await (userRewards.claimDailyReward as any).run(request);
      if (uid) {
        await notificationApiRouter({ ...request, data: { type: "WALLET", data: { userId: uid, amount: response.rewardAmount, transactionType: "daily_reward" } } } as any);
      }
      break;
    
    // ================= WALLET =================
    case "topup":
      response = await (walletTopup.topUpWallet as any).run(request);
      if (uid) {
        await notificationApiRouter({ ...request, data: { type: "WALLET", data: { userId: uid, amount: request.data.amount, transactionType: "topup" } } } as any);
      }
      break;

    // ================= STORAGE (UPDATED) =================
    case "uploadDirect":    // ADDED
    case "getPresignedUrl": 
    case "getUploadUrl":    
    case "deleteFile":
    case "startMultipart":
    case "getPartUrls":
    case "completeMultipart":
    case "finalizeUpload":
      return await storageApi(request);

    // ================= FALLBACK =================
    default:
      const actions: any = {
        "createPost": posts.createPost,
        "deletePost": posts.deleteUserPost,
        "storyHandler": stories.storyHandler,
        "setAdminRole": adminTools.setAdminRole,
        "adminDeletePost": adminTools.deletePost,
        "unblockUser": adminTools.unblockUser,
        "adminManageWallet": walletAdmin.adminManageWallet
      };

      if (actions[action]) {
        return await (actions[action] as any).run(request);
      }

      throw new HttpsError("invalid-argument", `Action '${action}' nahi mila.`);
  }

  return response;
};
