"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.onFollowCreated = exports.onLikeCreated = exports.onCommentCreated = void 0;
const firestore_1 = require("firebase-functions/v2/firestore");
const firestore_2 = require("firebase-admin/firestore");
const firebase_functions_1 = require("firebase-functions");
const node_fetch_1 = __importDefault(require("node-fetch"));
const db = (0, firestore_2.getFirestore)();
/**
 * PRODUCTION-GRADE: Send Push Notification via Expo Push API
 * Handling Expo Push Tokens (ExponentPushToken[...])
 */
async function sendExpoPushNotification(recipientId, token, title, body, data) {
    try {
        const message = {
            to: token,
            sound: 'default',
            title: title,
            body: body,
            data: data,
            priority: 'high',
            channelId: 'default',
        };
        const response = await (0, node_fetch_1.default)('https://exp.host/--/api/v2/push/send', {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Accept-encoding': 'gzip, deflate',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(message),
        });
        const resData = await response.json();
        firebase_functions_1.logger.info(`Expo Push sent to ${recipientId}`, resData);
    }
    catch (error) {
        firebase_functions_1.logger.error(`Failed to send Expo Push to ${recipientId}`, error);
    }
}
/**
 * Helper to save notification to Firestore and trigger Push
 */
async function createAndSendNotification(recipientId, notification) {
    try {
        // 1. Save to Firestore (Requirement 3)
        const notifRef = db.collection("notifications").doc(recipientId).collection("items").doc();
        await notifRef.set(Object.assign(Object.assign({}, notification), { read: false, createdAt: firestore_2.FieldValue.serverTimestamp() }));
        // 2. Fetch User's Push Token
        const userDoc = await db.collection("users").doc(recipientId).get();
        const userData = userDoc.data();
        const pushToken = (userData === null || userData === void 0 ? void 0 : userData.pushToken) || (userData === null || userData === void 0 ? void 0 : userData.fcmToken);
        if (!pushToken) {
            firebase_functions_1.logger.warn(`No token for user ${recipientId}.`);
            return;
        }
        // 3. Send via Expo Push API
        await sendExpoPushNotification(recipientId, pushToken, notification.title, notification.body, { type: notification.type, targetId: notification.targetId });
    }
    catch (error) {
        firebase_functions_1.logger.error("Error in createAndSendNotification:", error);
    }
}
/**
 * TRIGGERS
 */
exports.onCommentCreated = (0, firestore_1.onDocumentCreated)("posts/{postId}/comments/{commentId}", async (event) => {
    const snapshot = event.data;
    if (!snapshot)
        return;
    const commentData = snapshot.data();
    const postId = event.params.postId;
    const postDoc = await db.collection("posts").doc(postId).get();
    const postData = postDoc.data();
    if (!postData || postData.userId === commentData.userId)
        return;
    await createAndSendNotification(postData.userId, {
        title: "New Comment! 💬",
        body: `${commentData.userName || "Someone"} commented: ${commentData.text}`,
        type: "comment",
        targetId: postId,
        senderId: commentData.userId,
        senderName: commentData.userName,
        senderAvatar: commentData.userAvatar,
        postImage: postData.imageUrl,
    });
});
exports.onLikeCreated = (0, firestore_1.onDocumentCreated)("posts/{postId}/likes/{likeId}", async (event) => {
    const snapshot = event.data;
    if (!snapshot)
        return;
    const likeData = snapshot.data();
    const postId = event.params.postId;
    const postDoc = await db.collection("posts").doc(postId).get();
    const postData = postDoc.data();
    if (!postData || postData.userId === likeData.userId)
        return;
    await createAndSendNotification(postData.userId, {
        title: "New Like! ❤️",
        body: `${likeData.userName || "Someone"} liked your post.`,
        type: "like",
        targetId: postId,
        senderId: likeData.userId,
        senderName: likeData.userName,
        senderAvatar: likeData.userAvatar,
        postImage: postData.imageUrl,
    });
});
exports.onFollowCreated = (0, firestore_1.onDocumentCreated)("users/{userId}/followers/{followerId}", async (event) => {
    const snapshot = event.data;
    if (!snapshot)
        return;
    const followerData = snapshot.data();
    const targetUserId = event.params.userId;
    await createAndSendNotification(targetUserId, {
        title: "New Follower! 👤",
        body: `${followerData.displayName || "Someone"} started following you.`,
        type: "follow",
        targetId: followerData.uid,
        senderId: followerData.uid,
        senderName: followerData.displayName,
        senderAvatar: followerData.photoURL,
    });
});
//# sourceMappingURL=notifications.js.map