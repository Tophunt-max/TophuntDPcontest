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
import * as notifUtils from "../notifications/utils";
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
    case "sendBroadcastNotification": {
      // Admin check
      if (!uid || !(await isAdmin(uid))) throw new HttpsError("permission-denied", "Admin only.");
      const { title, body, imageUrl, data } = request.data;
      const sentCount = await notifUtils.sendBroadcastToAllUsers(title, body, imageUrl, data || {});
      return { success: true, sentCount };
    }
    case "sendIndividualNotification": {
      if (!uid || !(await isAdmin(uid))) throw new HttpsError("permission-denied", "Admin only.");
      const { userId, title, body, imageUrl, data } = request.data;
      if (!userId) throw new HttpsError("invalid-argument", "User ID is required");
      
      await notifUtils.createNotification(userId, {
        title,
        body,
        type: "admin",
        targetId: "individual_msg",
        image: imageUrl,
        data: data || {}
      });
      return { success: true };
    }
    
    // Admin: Contest Creation logic
    case "createContestTemplate":
      if (!uid || !(await isAdmin(uid))) throw new HttpsError("permission-denied", "Admin only.");
      const contestRef = db.collection("contests").doc();
      await contestRef.set({ ...request.data, status: "live", createdAt: FieldValue.serverTimestamp(), createdBy: uid });
      return { success: true, contestId: contestRef.id };

    // Admin: Dashboard Stats logic
    case "getAdminStats":
      if (!uid || !(await isAdmin(uid))) throw new HttpsError("permission-denied", "Admin only.");
      const usersCountDoc = await db.collection("users").count().get();
      const usersCount = usersCountDoc.data().count;
      const activeMatchesDoc = await db.collection("contestMatches").where("status", "==", "active").count().get();
      const activeMatches = activeMatchesDoc.data().count;
      const waitingMatchesDoc = await db.collection("contestMatches").where("status", "==", "waiting_for_opponent").count().get();
      const waitingMatches = waitingMatchesDoc.data().count;
      const latestTransactions = await db.collection("coinTransactions").orderBy("timestamp", "desc").limit(10).get();
      return { stats: { usersCount, activeMatches, waitingMatches }, latestTransactions: latestTransactions.docs.map(doc => ({ id: doc.id, ...doc.data() })) };
      
    // Admin: Search Users (Simple Prefix Search)
    case "searchUsers": {
       if (!uid || !(await isAdmin(uid))) throw new HttpsError("permission-denied", "Admin only.");
       const { query } = request.data;
       if (!query || query.length < 2) return { users: [] };
       
       const term = query.toLowerCase();
       
       // Note: Firestore doesn't support native partial matching without 3rd party like Algolia.
       // We'll do a simple >= prefix search on 'username'
       // Ensure you have an index on 'username' if not already there.
       
       const usersSnapshot = await db.collection("users")
        .where("username", ">=", term)
        .where("username", "<=", term + '\uf8ff')
        .limit(10)
        .get();

       const users = usersSnapshot.docs.map(doc => ({
           id: doc.id,
           username: doc.data().username || "Unknown",
           email: doc.data().email || "",
           avatar: doc.data().profileImage || ""
       }));
       
       return { users };
    }

    // ================= STORAGE =================
    case "getPresignedUrl":
      return await (storage.generatePresignedUrl as any).run(request);

    default:
      throw new HttpsError("invalid-argument", `Action '${action}' nahi mila.`);
  }
};
