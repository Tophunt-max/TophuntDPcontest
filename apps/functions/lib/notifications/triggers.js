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
exports.onIncomingCall = exports.onNewChatMessage = exports.onUserLevelUp = exports.onProfileVisit = exports.onShare = exports.onUserFollow = exports.onCoinTransaction = exports.onMatchStatusUpdate = exports.onMatchCreated = exports.onCommentLike = exports.onMatchComment = exports.onMatchLike = exports.onPostComment = exports.onPostLike = void 0;
const firestore_1 = require("firebase-functions/v2/firestore");
const database_1 = require("firebase-functions/v2/database");
const admin = __importStar(require("firebase-admin"));
const db = admin.firestore();
/**
 * UTILITY: Create Notification Record
 * This replaces the previous utility to keep everything within the namespace.
 */
async function createNotification(userId, data) {
    const notificationRef = db.collection("users").doc(userId).collection("notifications").doc();
    await notificationRef.set(Object.assign(Object.assign({}, data), { id: notificationRef.id, read: false, createdAt: admin.firestore.FieldValue.serverTimestamp() }));
}
// 1. Post Like Trigger
exports.onPostLike = (0, firestore_1.onDocumentCreated)("posts/{postId}/likes/{userId}", async (event) => {
    var _a;
    const snapshot = event.data;
    if (!snapshot)
        return;
    const { postId, userId: likerId } = event.params;
    const postDoc = await db.collection("posts").doc(postId).get();
    if (!postDoc.exists)
        return;
    const postData = postDoc.data();
    const authorId = postData === null || postData === void 0 ? void 0 : postData.userId;
    if (authorId && authorId !== likerId) {
        const likerDoc = await db.collection("users").doc(likerId).get();
        const likerName = ((_a = likerDoc.data()) === null || _a === void 0 ? void 0 : _a.username) || "Someone";
        await createNotification(authorId, {
            title: "New Like ❤️",
            body: `${likerName} liked your post.`,
            type: "like",
            targetId: postId,
            image: postData === null || postData === void 0 ? void 0 : postData.mediaUrl
        });
    }
});
// 2. Post Comment & Reply Trigger
exports.onPostComment = (0, firestore_1.onDocumentCreated)("posts/{postId}/comments/{commentId}", async (event) => {
    var _a, _b;
    const snapshot = event.data;
    if (!snapshot)
        return;
    const { postId } = event.params;
    const commentData = snapshot.data();
    const commenterId = commentData.userId;
    const parentId = commentData.parentId;
    const commenterDoc = await db.collection("users").doc(commenterId).get();
    const commenterName = ((_a = commenterDoc.data()) === null || _a === void 0 ? void 0 : _a.username) || "Someone";
    const postDoc = await db.collection("posts").doc(postId).get();
    if (!postDoc.exists)
        return;
    const postData = postDoc.data();
    const postAuthorId = postData === null || postData === void 0 ? void 0 : postData.userId;
    if (parentId) {
        const parentCommentDoc = await db.collection("posts").doc(postId).collection("comments").doc(parentId).get();
        if (parentCommentDoc.exists) {
            const parentAuthorId = (_b = parentCommentDoc.data()) === null || _b === void 0 ? void 0 : _b.userId;
            if (parentAuthorId && parentAuthorId !== commenterId) {
                await createNotification(parentAuthorId, {
                    title: "New Reply ↩️",
                    body: `${commenterName} replied: "${commentData.text}"`,
                    type: "reply",
                    targetId: postId,
                    image: postData === null || postData === void 0 ? void 0 : postData.mediaUrl
                });
            }
            return;
        }
    }
    if (postAuthorId && postAuthorId !== commenterId) {
        await createNotification(postAuthorId, {
            title: "New Comment 💬",
            body: `${commenterName} commented: "${commentData.text}"`,
            type: "comment",
            targetId: postId,
            image: postData === null || postData === void 0 ? void 0 : postData.mediaUrl
        });
    }
});
// 3. Contest Match Like Trigger
exports.onMatchLike = (0, firestore_1.onDocumentCreated)("contestMatches/{matchId}/likes/{userId}", async (event) => {
    var _a;
    const snapshot = event.data;
    if (!snapshot)
        return;
    const { matchId, userId: likerId } = event.params;
    const matchDoc = await db.collection("contestMatches").doc(matchId).get();
    if (!matchDoc.exists)
        return;
    const matchData = matchDoc.data();
    const participants = [matchData === null || matchData === void 0 ? void 0 : matchData.creatorId, matchData === null || matchData === void 0 ? void 0 : matchData.opponentId].filter(id => id && id !== likerId);
    const uniqueParticipants = [...new Set(participants)];
    if (uniqueParticipants.length > 0) {
        const likerDoc = await db.collection("users").doc(likerId).get();
        const likerName = ((_a = likerDoc.data()) === null || _a === void 0 ? void 0 : _a.username) || "Someone";
        for (const pid of uniqueParticipants) {
            await createNotification(pid, {
                title: "Battle Like! 🔥",
                body: `${likerName} liked your battle.`,
                type: "contest",
                targetId: matchId
            });
        }
    }
});
// 4. Contest Match Comment Trigger
exports.onMatchComment = (0, firestore_1.onDocumentCreated)("contestMatches/{matchId}/comments/{commentId}", async (event) => {
    var _a;
    const snapshot = event.data;
    if (!snapshot)
        return;
    const { matchId } = event.params;
    const commentData = snapshot.data();
    const commenterId = commentData.userId;
    const matchDoc = await db.collection("contestMatches").doc(matchId).get();
    if (!matchDoc.exists)
        return;
    const matchData = matchDoc.data();
    const participants = [matchData === null || matchData === void 0 ? void 0 : matchData.creatorId, matchData === null || matchData === void 0 ? void 0 : matchData.opponentId].filter(id => id && id !== commenterId);
    const uniqueParticipants = [...new Set(participants)];
    if (uniqueParticipants.length > 0) {
        const commenterDoc = await db.collection("users").doc(commenterId).get();
        const commenterName = ((_a = commenterDoc.data()) === null || _a === void 0 ? void 0 : _a.username) || "Someone";
        for (const pid of uniqueParticipants) {
            await createNotification(pid, {
                title: "Battle Comment 💬",
                body: `${commenterName} commented on your battle.`,
                type: "contest",
                targetId: matchId
            });
        }
    }
});
// 5. Comment Like Trigger
exports.onCommentLike = (0, firestore_1.onDocumentCreated)("posts/{postId}/comments/{commentId}/likes/{userId}", async (event) => {
    var _a, _b;
    const snapshot = event.data;
    if (!snapshot)
        return;
    const { postId, commentId, userId: likerId } = event.params;
    const commentDoc = await db.collection("posts").doc(postId).collection("comments").doc(commentId).get();
    if (!commentDoc.exists)
        return;
    const commentAuthorId = (_a = commentDoc.data()) === null || _a === void 0 ? void 0 : _a.userId;
    if (commentAuthorId && commentAuthorId !== likerId) {
        const likerDoc = await db.collection("users").doc(likerId).get();
        const likerName = ((_b = likerDoc.data()) === null || _b === void 0 ? void 0 : _b.username) || "Someone";
        const postDoc = await db.collection("posts").doc(postId).get();
        const postData = postDoc.data();
        await createNotification(commentAuthorId, {
            title: "Comment Liked ❤️",
            body: `${likerName} liked your comment.`,
            type: "comment-like",
            targetId: postId,
            image: postData === null || postData === void 0 ? void 0 : postData.mediaUrl
        });
    }
});
// 6. Battle Challenge Notifications
exports.onMatchCreated = (0, firestore_1.onDocumentCreated)("contestMatches/{matchId}", async (event) => {
    var _a, _b;
    const snapshot = event.data;
    if (!snapshot)
        return;
    const matchData = snapshot.data();
    const { creatorId, opponentId, status } = matchData;
    if (status === 'pending' && opponentId) {
        const creatorDoc = await db.collection("users").doc(creatorId).get();
        const creatorName = ((_a = creatorDoc.data()) === null || _a === void 0 ? void 0 : _a.username) || "Someone";
        await createNotification(opponentId, {
            title: "New Challenge! ⚔️",
            body: `${creatorName} challenged you to a battle!`,
            type: "contest-invite",
            targetId: event.params.matchId,
            image: (_b = creatorDoc.data()) === null || _b === void 0 ? void 0 : _b.photoURL
        });
    }
});
// 7. Battle Status Update & Follower Notifications
exports.onMatchStatusUpdate = (0, firestore_1.onDocumentUpdated)("contestMatches/{matchId}", async (event) => {
    var _a, _b, _c;
    const change = event.data;
    if (!change)
        return;
    const newData = change.after.data();
    const oldData = change.before.data();
    const { matchId } = event.params;
    if (oldData.status === 'pending' && newData.status === 'active') {
        const creatorId = newData.creatorId;
        const opponentId = newData.opponentId;
        const creatorDoc = await db.collection("users").doc(creatorId).get();
        const opponentDoc = await db.collection("users").doc(opponentId).get();
        const creatorName = ((_a = creatorDoc.data()) === null || _a === void 0 ? void 0 : _a.username) || "Someone";
        const opponentName = ((_b = opponentDoc.data()) === null || _b === void 0 ? void 0 : _b.username) || "Someone";
        await createNotification(creatorId, {
            title: "Challenge Accepted! 🚀",
            body: `${opponentName} accepted your challenge. Battle starts now!`,
            type: "contest-start",
            targetId: matchId,
            image: (_c = opponentDoc.data()) === null || _c === void 0 ? void 0 : _c.photoURL
        });
        const creatorFollowers = await db.collection("users").doc(creatorId).collection("followers").limit(100).get();
        const creatorPromises = creatorFollowers.docs.map(doc => {
            var _a;
            return createNotification(doc.id, {
                title: "Battle Alert! ⚔️",
                body: `${creatorName} started a battle with ${opponentName}.`,
                type: "contest-watch",
                targetId: matchId,
                image: (_a = creatorDoc.data()) === null || _a === void 0 ? void 0 : _a.photoURL
            });
        });
        await Promise.all(creatorPromises);
        const opponentFollowers = await db.collection("users").doc(opponentId).collection("followers").limit(100).get();
        const opponentPromises = opponentFollowers.docs.map(doc => {
            var _a;
            return createNotification(doc.id, {
                title: "Battle Alert! ⚔️",
                body: `${opponentName} started a battle with ${creatorName}.`,
                type: "contest-watch",
                targetId: matchId,
                image: (_a = opponentDoc.data()) === null || _a === void 0 ? void 0 : _a.photoURL
            });
        });
        await Promise.all(opponentPromises);
    }
    if (oldData.status !== 'finished' && newData.status === 'finished') {
        const winnerId = newData.winnerId;
        if (winnerId) {
            await createNotification(winnerId, {
                title: "You Won! 🏆",
                body: "Congratulations! You won the battle.",
                type: "contest-win",
                targetId: matchId
            });
        }
        const participants = [newData.creatorId, newData.opponentId];
        const loserId = participants.find(id => id !== winnerId);
        if (loserId) {
            await createNotification(loserId, {
                title: "Battle Ended",
                body: "The battle has ended. Check the results.",
                type: "contest-end",
                targetId: matchId
            });
        }
    }
});
// 8. Wallet Transaction Notifications
exports.onCoinTransaction = (0, firestore_1.onDocumentCreated)("coin_transactions/{transactionId}", async (event) => {
    const snapshot = event.data;
    if (!snapshot)
        return;
    const data = snapshot.data();
    const { userId, type, amount } = data;
    if (!userId || !amount)
        return;
    let title = "Coins Received 💰";
    let body = `You received ${amount} coins.`;
    switch (type) {
        case 'purchase':
            title = "Wallet Top-up Successful 💰";
            body = `Success! ${amount} Fish Coins have been added to your wallet.`;
            break;
        case 'reward':
        case 'battle_win':
            title = "Reward Earned! 🏆";
            body = `You earned ${amount} Fish Coins from your victory!`;
            break;
        case 'signup_bonus':
            title = "Welcome Bonus! 🎁";
            body = `Welcome to TopHunt! Here are ${amount} coins to get you started.`;
            break;
        case 'daily_login':
            title = "Daily Login Reward 🔥";
            body = `You claimed your daily login reward of ${amount} coins. Keep the streak!`;
            break;
        case 'referral_bonus':
            title = "Referral Reward 🤝";
            body = `Your friend joined using your code! You earned ${amount} coins.`;
            break;
        default:
            return;
    }
    await createNotification(userId, {
        title,
        body,
        type: "wallet",
        targetId: "wallet"
    });
});
// 9. User Follow Notification
exports.onUserFollow = (0, firestore_1.onDocumentCreated)("users/{userId}/followers/{followerId}", async (event) => {
    const snapshot = event.data;
    if (!snapshot)
        return;
    const { userId, followerId } = event.params;
    const followerDoc = await db.collection("users").doc(followerId).get();
    if (!followerDoc.exists)
        return;
    const followerData = followerDoc.data();
    const followerName = (followerData === null || followerData === void 0 ? void 0 : followerData.username) || "Someone";
    await createNotification(userId, {
        title: "New Follower! 🌟",
        body: `${followerName} started following you.`,
        type: "follow",
        targetId: followerId,
        image: followerData === null || followerData === void 0 ? void 0 : followerData.photoURL
    });
    const userRef = db.collection("users").doc(userId);
    const userDoc = await userRef.get();
    const userData = userDoc.data();
    const currentFollowers = ((userData === null || userData === void 0 ? void 0 : userData.followersCount) || 0) + 1;
    await userRef.update({ followersCount: currentFollowers });
    const milestones = [10, 50, 100, 500, 1000, 5000];
    if (milestones.includes(currentFollowers)) {
        await createNotification(userId, {
            title: "Milestone Unlocked! 🎉",
            body: `Congratulations! You just reached ${currentFollowers} followers.`,
            type: "milestone",
            targetId: userId,
            image: userData === null || userData === void 0 ? void 0 : userData.photoURL
        });
    }
});
// 10. Content Share Trigger
exports.onShare = (0, firestore_1.onDocumentCreated)("shares/{shareId}", async (event) => {
    var _a, _b;
    const snapshot = event.data;
    if (!snapshot)
        return;
    const data = snapshot.data();
    const { userId, contentId, contentType, sharedBy } = data;
    if (userId && sharedBy && userId !== sharedBy) {
        const sharerDoc = await db.collection("users").doc(sharedBy).get();
        const sharerName = ((_a = sharerDoc.data()) === null || _a === void 0 ? void 0 : _a.username) || "Someone";
        await createNotification(userId, {
            title: "Content Shared! 🚀",
            body: `Your ${contentType || 'post'} was shared by ${sharerName}.`,
            type: "share",
            targetId: contentId,
            image: (_b = sharerDoc.data()) === null || _b === void 0 ? void 0 : _b.photoURL
        });
    }
});
// 11. Profile Visit Trigger
exports.onProfileVisit = (0, firestore_1.onDocumentCreated)("users/{userId}/profileVisits/{visitorId}", async (event) => {
    var _a, _b;
    const snapshot = event.data;
    if (!snapshot)
        return;
    const { userId, visitorId } = event.params;
    if (userId === visitorId)
        return;
    const visitorDoc = await db.collection("users").doc(visitorId).get();
    const visitorName = ((_a = visitorDoc.data()) === null || _a === void 0 ? void 0 : _a.username) || "Someone";
    await createNotification(userId, {
        title: "New Profile Visitor 👀",
        body: `${visitorName} viewed your profile.`,
        type: "profile-visit",
        targetId: visitorId,
        image: (_b = visitorDoc.data()) === null || _b === void 0 ? void 0 : _b.photoURL
    });
});
// 12. User Level Up Trigger
exports.onUserLevelUp = (0, firestore_1.onDocumentUpdated)("users/{userId}", async (event) => {
    const change = event.data;
    if (!change)
        return;
    const oldData = change.before.data();
    const newData = change.after.data();
    const oldLevel = Math.floor((oldData.xp || 0) / 1000);
    const newLevel = Math.floor((newData.xp || 0) / 1000);
    if (newLevel > oldLevel) {
        await createNotification(event.params.userId, {
            title: "Level Up! 🆙",
            body: `Congratulations! You reached Level ${newLevel}. Keep battling!`,
            type: "level-up",
            targetId: "profile",
            image: newData.photoURL
        });
    }
});
/**
 * CHAT & CALL TRIGGERS (Moved from chatTriggers.ts to combine into one group)
 */
exports.onNewChatMessage = (0, firestore_1.onDocumentCreated)("chats/{chatId}/messages/{messageId}", async (event) => {
    var _a, _b, _c, _d;
    const messageData = (_a = event.data) === null || _a === void 0 ? void 0 : _a.data();
    if (!messageData)
        return;
    const { chatId, senderId, content, type } = messageData;
    if (senderId === 'system')
        return;
    const chatDoc = await db.collection("chats").doc(chatId).get();
    const chatData = chatDoc.data();
    if (!chatData)
        return;
    const recipientId = chatData.participants.find((id) => id !== senderId);
    if (!recipientId)
        return;
    const senderName = ((_c = (_b = chatData.participantsData) === null || _b === void 0 ? void 0 : _b[senderId]) === null || _c === void 0 ? void 0 : _c.displayName) || "Someone";
    const userDoc = await db.collection("users").doc(recipientId).get();
    const fcmToken = (_d = userDoc.data()) === null || _d === void 0 ? void 0 : _d.fcmToken;
    if (!fcmToken)
        return;
    const payload = {
        notification: { title: senderName, body: type === 'text' ? content : `Sent a ${type.replace('_', ' ')}` },
        data: { type: "message", chatId, senderId, url: `/messages/chat/${chatId}` },
        token: fcmToken
    };
    try {
        await admin.messaging().send(payload);
    }
    catch (error) {
        console.error("Error:", error);
    }
});
exports.onIncomingCall = (0, database_1.onValueCreated)({
    ref: "/calls/{chatId}",
    instance: "tophuntdpcontest",
    region: "us-central1"
}, async (event) => {
    var _a, _b, _c, _d, _e;
    const callData = (_a = event.data) === null || _a === void 0 ? void 0 : _a.val();
    if (!callData || callData.status !== 'initiating')
        return;
    const { chatId, callerId, receiverId, type } = callData;
    const chatDoc = await db.collection("chats").doc(chatId).get();
    const callerName = ((_d = (_c = (_b = chatDoc.data()) === null || _b === void 0 ? void 0 : _b.participantsData) === null || _c === void 0 ? void 0 : _c[callerId]) === null || _d === void 0 ? void 0 : _d.displayName) || "Someone";
    const userDoc = await db.collection("users").doc(receiverId).get();
    const fcmToken = (_e = userDoc.data()) === null || _e === void 0 ? void 0 : _e.fcmToken;
    if (!fcmToken)
        return;
    const payload = {
        notification: { title: `Incoming ${type} call`, body: `${callerName} is calling you...` },
        data: { type: "call", chatId, callType: type, url: `/messages/chat/${chatId}` },
        android: { priority: "high", notification: { channelId: "calls", sound: "default" } },
        token: fcmToken
    };
    try {
        await admin.messaging().send(payload);
    }
    catch (error) {
        console.error("Error:", error);
    }
});
//# sourceMappingURL=triggers.js.map