"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.notificationApiRouter = void 0;
const https_1 = require("firebase-functions/v2/https");
const firebase_1 = require("../utils/firebase");
const utils_1 = require("../notifications/utils");
/**
 * CENTRALIZED NOTIFICATION API
 * Handles all 12+ notification types in one single function to save Quota.
 */
const notificationApiRouter = async (request) => {
    var _a, _b;
    const { type, data } = request.data;
    if (!type || !data)
        throw new https_1.HttpsError("invalid-argument", "Type and Data are required.");
    switch (type) {
        // 1 & 5. Likes (Posts, Comments, Matches)
        case "LIKE": {
            const { targetId, targetType, likerId, authorId, image } = data;
            if (authorId === likerId)
                return { success: true };
            const likerDoc = await firebase_1.db.collection("users").doc(likerId).get();
            const likerName = ((_a = likerDoc.data()) === null || _a === void 0 ? void 0 : _a.username) || "Someone";
            await (0, utils_1.createNotification)(authorId, {
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
            if (authorId === commenterId)
                return { success: true };
            const commenterDoc = await firebase_1.db.collection("users").doc(commenterId).get();
            const commenterName = ((_b = commenterDoc.data()) === null || _b === void 0 ? void 0 : _b.username) || "Someone";
            await (0, utils_1.createNotification)(authorId, {
                title: isReply ? "New Reply ↩️" : "New Comment 💬",
                body: `${commenterName} ${isReply ? 'replied' : 'commented'}: "${text}"`,
                type: (isReply ? "reply" : "comment"),
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
            let notifType = "contest";
            if (action === "CHALLENGE") {
                title = "New Challenge! ⚔️";
                body = `${senderName} challenged you to a battle!`;
                notifType = "contest-invite";
            }
            else if (action === "ACCEPTED") {
                title = "Challenge Accepted! 🚀";
                body = `${senderName} accepted your challenge. Battle starts now!`;
                notifType = "contest-start";
            }
            else if (action === "WIN") {
                title = "You Won! 🏆";
                body = "Congratulations! You won the battle.";
                notifType = "contest-win";
            }
            await (0, utils_1.createNotification)(receiverId, {
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
            await (0, utils_1.createNotification)(userId, {
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
            const followerDoc = await firebase_1.db.collection("users").doc(followerId).get();
            const followerData = followerDoc.data();
            await (0, utils_1.createNotification)(targetUserId, {
                title: "New Follower! 🌟",
                body: `${(followerData === null || followerData === void 0 ? void 0 : followerData.username) || "Someone"} started following you.`,
                type: "follow",
                targetId: followerId,
                image: followerData === null || followerData === void 0 ? void 0 : followerData.photoURL
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
            }
            else if (subType === "LEVEL_UP") {
                title = "Level Up! 🆙";
                body = "Congratulations! You've reached a new level.";
            }
            await (0, utils_1.createNotification)(userId, {
                title,
                body,
                type: "system",
                targetId: targetId || "profile"
            });
            break;
        }
        default:
            throw new https_1.HttpsError("invalid-argument", "Unknown notification type.");
    }
    return { success: true };
};
exports.notificationApiRouter = notificationApiRouter;
//# sourceMappingURL=notificationApi.js.map