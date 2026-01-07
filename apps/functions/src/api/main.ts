import { HttpsError, CallableRequest } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";

// Sabhi purane modules ko import kar rahe hain (Auth aur Update actions ko chhod kar)
import * as contests from "../contests/contestHandler";
import * as engagement from "../contests/engagement";
import * as matches from "../contests/matchHandler";
import * as voting from "../contests/voting";
import * as posts from "../posts/index";
import * as stories from "../stories/index";
import * as userRewards from "../user/rewards";
import * as userSocial from "../user/toggleFollow";
import * as walletTopup from "../wallet/topup";
import * as walletAdmin from "../wallet/adminWalletManagement";
import * as adminTools from "../admin/index";
import * as notifSender from "../notifications/sender";
import * as storage from "../storage/presignedUrl";

// Special logic
import { db, isAdmin } from "../utils/firebase";
import { FieldValue } from "firebase-admin/firestore";

export const masterApiRouter = async (request: CallableRequest) => {
  const { action } = request.data;
  const uid = request.auth?.uid;

  if (!action) {
    throw new HttpsError("invalid-argument", "Action specify karna zaroori hai.");
  }

  logger.info(`[Action Called]: ${action} by UID: ${uid || 'Guest'}`);

  switch (action) {
    
    // Auth aur User Email/Phone Update ab authHandler se handle hote hain.

    // ================= CONTESTS & MATCHES =================
    case "join":
    case "vote":
      return await (contests.contestHandler as any).run(request);
    case "likeContest":
      return await (engagement.likeContest as any).run(request);
    case "commentContest":
      return await (engagement.commentOnContest as any).run(request);
    case "shareContest":
      return await (engagement.shareContest as any).run(request);
    case "startMatch":
      return await (matches.startContestMatch as any).run(request);
    case "joinMatch":
      return await (matches.joinContestMatch as any).run(request);
    case "submitVote":
      return await (voting.submitVote as any).run(request);

    // ================= POSTS & STORIES =================
    case "createPost":
      return await (posts.createPost as any).run(request);
    case "deletePost":
      return await (posts.deleteUserPost as any).run(request);
    case "createStory":
      return await (stories.createStory as any).run(request);
    case "deleteStory":
      return await (stories.deleteStory as any).run(request);
    case "getStoryUrl":
      return await (stories.generateStoryUploadUrl as any).run(request);

    // ================= USER & SOCIAL =================
    case "toggleFollow":
      return await (userSocial.toggleFollow as any).run(request);
    case "claimDailyReward":
      return await (userRewards.claimDailyReward as any).run(request);
    
    // sendEmailOtp, verifyEmailOtp, sendPhoneOtp, verifyPhoneOtp are now in authHandler

    // ================= WALLET =================
    case "topup":
      return await (walletTopup.topUpWallet as any).run(request);
    case "adminManageWallet":
      return await (walletAdmin.adminManageWallet as any).run(request);

    // ================= ADMIN TOOLS =================
    case "setAdminRole":
      return await (adminTools.setAdminRole as any).run(request);
    case "adminDeletePost":
      return await (adminTools.deletePost as any).run(request);
    case "unblockUser":
      return await (adminTools.unblockUser as any).run(request);
    case "sendBroadcastNotification":
      return await (notifSender.sendBroadcastNotification as any).run(request);
    
    // Admin: Contest Creation logic
    case "createContestTemplate":
      if (!uid || !(await isAdmin(uid))) throw new HttpsError("permission-denied", "Admin only.");
      const contestRef = db.collection("contests").doc();
      await contestRef.set({ ...request.data, status: "live", createdAt: FieldValue.serverTimestamp(), createdBy: uid });
      return { success: true, contestId: contestRef.id };

    // Admin: Dashboard Stats logic
    case "getAdminStats":
      if (!uid || !(await isAdmin(uid))) throw new HttpsError("permission-denied", "Admin only.");
      const usersCount = (await db.collection("users").count().get()).data().count;
      const activeMatches = (await db.collection("contestMatches").where("status", "==", "active").count().get()).data().count;
      const waitingMatches = (await db.collection("contestMatches").where("status", "==", "waiting_for_opponent").count().get()).data().count;
      const latestTransactions = await db.collection("coinTransactions").orderBy("timestamp", "desc").limit(10).get();
      return { stats: { usersCount, activeMatches, waitingMatches }, latestTransactions: latestTransactions.docs.map(doc => ({ id: doc.id, ...doc.data() })) };

    // ================= STORAGE =================
    case "getPresignedUrl":
      return await (storage.generatePresignedUrl as any).run(request);

    default:
      throw new HttpsError("invalid-argument", `Action '${action}' nahi mila.`);
  }
};
