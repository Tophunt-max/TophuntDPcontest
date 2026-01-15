import { HttpsError, CallableRequest } from "firebase-functions/v2/https";
import { db } from "../utils/firebase";
import { createNotification, NotificationType } from "../notifications/utils";

/**
 * CENTRALIZED NOTIFICATION API
 * Handles all 12+ notification types in one single function to save Quota.
 */
export const notificationApiRouter = async (request: CallableRequest) => {
  const { type, data } = request.data;

  if (!type || !data) throw new HttpsError("invalid-argument", "Type and Data are required.");

  switch (type) {
    // 1 & 5. Likes (Posts, Comments, Matches)
    case "LIKE": {
      const { targetId, targetType, likerId, authorId, image } = data;
      if (authorId === likerId) return { success: true };
      
      const likerDoc = await db.collection("users").doc(likerId).get();
      const likerName = likerDoc.data()?.username || "Someone";

      await createNotification(authorId, {
        title: targetType === "comment" ? "Comment Liked ❤️" : "New Like ❤️",
        body: `${likerName} liked your ${targetType}.`,
        type: "like",
        targetId: targetId,
        image: image
      });
      break;
    }

    // 2 & 4. Comments (Posts, Matches, Replies)
    case "COMMENT": {
      const { targetId, authorId, commenterId, text, image, isReply } = data;
      if (authorId === commenterId) return { success: true };

      const commenterDoc = await db.collection("users").doc(commenterId).get();
      const commenterName = commenterDoc.data()?.username || "Someone";

      await createNotification(authorId, {
        title: isReply ? "New Reply ↩️" : "New Comment 💬",
        body: `${commenterName} ${isReply ? 'replied' : 'commented'}: "${text}"`,
        type: (isReply ? "reply" : "comment") as NotificationType,
        targetId: targetId,
        image: image
      });
      break;
    }

    // 6 & 7. Battles (Challenges, Accept, Win)
    case "BATTLE": {
      const { action, matchId, receiverId, senderName, image } = data;
      
      let title = "Battle Update ⚔️";
      let body = "Update on your battle.";
      let notifType: NotificationType = "contest";

      if (action === "CHALLENGE") {
        title = "New Challenge! ⚔️";
        body = `${senderName} challenged you to a battle!`;
        notifType = "contest-invite";
      } else if (action === "ACCEPTED") {
        title = "Challenge Accepted! 🚀";
        body = `${senderName} accepted your challenge. Battle starts now!`;
        notifType = "contest-start";
      } else if (action === "WIN") {
        title = "You Won! 🏆";
        body = "Congratulations! You won the battle.";
        notifType = "contest-win";
      }

      await createNotification(receiverId, {
        title,
        body,
        type: notifType,
        targetId: matchId,
        image: image
      });
      break;
    }

    // 8. Wallet / Coins
    case "WALLET": {
      const { userId, amount, transactionType } = data;
      await createNotification(userId, {
        title: "Coins Received 💰",
        body: `You received ${amount} coins for ${transactionType}.`,
        type: "wallet",
        targetId: "wallet"
      });
      break;
    }

    // 9. Follow
    case "FOLLOW": {
      const { targetUserId, followerId } = data;
      const followerDoc = await db.collection("users").doc(followerId).get();
      const followerData = followerDoc.data();

      await createNotification(targetUserId, {
        title: "New Follower! 🌟",
        body: `${followerData?.username || "Someone"} started following you.`,
        type: "follow",
        targetId: followerId,
        image: followerData?.photoURL
      });
      break;
    }

    // 10, 11, 12. Profile Visit, Share, Level Up
    case "SYSTEM": {
      const { userId, subType, actorName, targetId } = data;
      let title = "System Notification";
      let body = "";

      if (subType === "VISIT") {
        title = "Profile Visitor 👀";
        body = `${actorName} viewed your profile.`;
      } else if (subType === "LEVEL_UP") {
        title = "Level Up! 🆙";
        body = "Congratulations! You've reached a new level.";
      }

      await createNotification(userId, {
        title,
        body,
        type: "system",
        targetId: targetId || "profile"
      });
      break;
    }

    default:
      throw new HttpsError("invalid-argument", "Unknown notification type.");
  }

  return { success: true };
};
