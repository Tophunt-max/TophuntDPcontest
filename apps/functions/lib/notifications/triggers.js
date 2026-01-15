"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.onUserLevelUp = exports.onProfileVisit = exports.onShare = exports.onUserFollow = exports.onCoinTransaction = exports.onMatchStatusUpdate = exports.onMatchCreated = exports.onCommentLike = exports.onMatchComment = exports.onMatchLike = exports.onPostComment = exports.onPostLike = void 0;
const firestore_1 = require("firebase-functions/v2/firestore");
const firebase_1 = require("../utils/firebase");
const utils_1 = require("./utils");
// 1. Post Like Trigger
exports.onPostLike = (0, firestore_1.onDocumentCreated)("posts/{postId}/likes/{userId}", async (event) => {
    var _a;
    const snapshot = event.data;
    if (!snapshot)
        return;
    const { postId, userId: likerId } = event.params;
    const postDoc = await firebase_1.db.collection("posts").doc(postId).get();
    if (!postDoc.exists)
        return;
    const postData = postDoc.data();
    const authorId = postData === null || postData === void 0 ? void 0 : postData.userId;
    if (authorId && authorId !== likerId) {
        const likerDoc = await firebase_1.db.collection("users").doc(likerId).get();
        const likerName = ((_a = likerDoc.data()) === null || _a === void 0 ? void 0 : _a.username) || "Someone";
        await (0, utils_1.createNotification)(authorId, {
            title: "New Like ❤️",
            body: `${likerName} liked your post.`,
            type: "like",
            targetId: postId,
            image: postData === null || postData === void 0 ? void 0 : postData.mediaUrl
        });
    }
});
// 2. Post Comment & Reply Trigger (MODIFIED)
exports.onPostComment = (0, firestore_1.onDocumentCreated)("posts/{postId}/comments/{commentId}", async (event) => {
    var _a;
    const snapshot = event.data;
    if (!snapshot)
        return;
    const { postId } = event.params;
    const commentData = snapshot.data();
    const commenterId = commentData.userId;
    const parentId = commentData.parentId; // Check if it's a reply
    // Fetch Commenter Details
    const commenterDoc = await firebase_1.db.collection("users").doc(commenterId).get();
    const commenterName = ((_a = commenterDoc.data()) === null || _a === void 0 ? void 0 : _a.username) || "Someone";
    // Fetch Post Details for Image
    const postDoc = await firebase_1.db.collection("posts").doc(postId).get();
    if (!postDoc.exists)
        return;
    const postData = postDoc.data();
    const postAuthorId = postData === null || postData === void 0 ? void 0 : postData.userId;
    // --- LOGIC FOR REPLIES ---
    if (parentId) {
        // Fetch the parent comment to find who we are replying to
        const parentCommentDoc = await firebase_1.db.collection("posts").doc(postId).collection("comments").doc(parentId).get();
        if (parentCommentDoc.exists) {
            const parentCommentData = parentCommentDoc.data();
            const parentAuthorId = parentCommentData === null || parentCommentData === void 0 ? void 0 : parentCommentData.userId;
            // Notify the author of the parent comment (if it's not the commenter themselves)
            if (parentAuthorId && parentAuthorId !== commenterId) {
                await (0, utils_1.createNotification)(parentAuthorId, {
                    title: "New Reply ↩️",
                    body: `${commenterName} replied: "${commentData.text}"`,
                    type: "reply",
                    targetId: postId, // Navigate to post
                    image: postData === null || postData === void 0 ? void 0 : postData.mediaUrl
                });
            }
            return;
        }
    }
    // --- LOGIC FOR DIRECT COMMENTS (No Parent ID) ---
    // Notify the Post Author (if not self-comment)
    if (postAuthorId && postAuthorId !== commenterId) {
        await (0, utils_1.createNotification)(postAuthorId, {
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
    const matchDoc = await firebase_1.db.collection("contestMatches").doc(matchId).get();
    if (!matchDoc.exists)
        return;
    const matchData = matchDoc.data();
    // Notify BOTH participants
    const participants = [matchData === null || matchData === void 0 ? void 0 : matchData.creatorId, matchData === null || matchData === void 0 ? void 0 : matchData.opponentId].filter(id => id && id !== likerId);
    // Deduplicate
    const uniqueParticipants = [...new Set(participants)];
    if (uniqueParticipants.length > 0) {
        const likerDoc = await firebase_1.db.collection("users").doc(likerId).get();
        const likerName = ((_a = likerDoc.data()) === null || _a === void 0 ? void 0 : _a.username) || "Someone";
        for (const pid of uniqueParticipants) {
            await (0, utils_1.createNotification)(pid, {
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
    const matchDoc = await firebase_1.db.collection("contestMatches").doc(matchId).get();
    if (!matchDoc.exists)
        return;
    const matchData = matchDoc.data();
    const participants = [matchData === null || matchData === void 0 ? void 0 : matchData.creatorId, matchData === null || matchData === void 0 ? void 0 : matchData.opponentId].filter(id => id && id !== commenterId);
    const uniqueParticipants = [...new Set(participants)];
    if (uniqueParticipants.length > 0) {
        const commenterDoc = await firebase_1.db.collection("users").doc(commenterId).get();
        const commenterName = ((_a = commenterDoc.data()) === null || _a === void 0 ? void 0 : _a.username) || "Someone";
        for (const pid of uniqueParticipants) {
            await (0, utils_1.createNotification)(pid, {
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
    var _a;
    const snapshot = event.data;
    if (!snapshot)
        return;
    const { postId, commentId, userId: likerId } = event.params;
    // Fetch the comment to get the author
    const commentDoc = await firebase_1.db.collection("posts").doc(postId).collection("comments").doc(commentId).get();
    if (!commentDoc.exists)
        return;
    const commentData = commentDoc.data();
    const commentAuthorId = commentData === null || commentData === void 0 ? void 0 : commentData.userId;
    // Prevent self-notification
    if (commentAuthorId && commentAuthorId !== likerId) {
        const likerDoc = await firebase_1.db.collection("users").doc(likerId).get();
        const likerName = ((_a = likerDoc.data()) === null || _a === void 0 ? void 0 : _a.username) || "Someone";
        const postDoc = await firebase_1.db.collection("posts").doc(postId).get();
        const postData = postDoc.data();
        await (0, utils_1.createNotification)(commentAuthorId, {
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
        const creatorDoc = await firebase_1.db.collection("users").doc(creatorId).get();
        const creatorName = ((_a = creatorDoc.data()) === null || _a === void 0 ? void 0 : _a.username) || "Someone";
        await (0, utils_1.createNotification)(opponentId, {
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
    // Status changed from 'pending' to 'active'
    if (oldData.status === 'pending' && newData.status === 'active') {
        const creatorId = newData.creatorId;
        const opponentId = newData.opponentId;
        const creatorDoc = await firebase_1.db.collection("users").doc(creatorId).get();
        const opponentDoc = await firebase_1.db.collection("users").doc(opponentId).get();
        const creatorName = ((_a = creatorDoc.data()) === null || _a === void 0 ? void 0 : _a.username) || "Someone";
        const opponentName = ((_b = opponentDoc.data()) === null || _b === void 0 ? void 0 : _b.username) || "Someone";
        // Notify Creator
        await (0, utils_1.createNotification)(creatorId, {
            title: "Challenge Accepted! 🚀",
            body: `${opponentName} accepted your challenge. Battle starts now!`,
            type: "contest-start",
            targetId: matchId,
            image: (_c = opponentDoc.data()) === null || _c === void 0 ? void 0 : _c.photoURL
        });
        // Notify Creator's Followers
        const creatorFollowers = await firebase_1.db.collection("users").doc(creatorId).collection("followers").limit(100).get();
        const creatorPromises = creatorFollowers.docs.map(doc => {
            var _a;
            return (0, utils_1.createNotification)(doc.id, {
                title: "Battle Alert! ⚔️",
                body: `${creatorName} started a battle with ${opponentName}.`,
                type: "contest-watch",
                targetId: matchId,
                image: (_a = creatorDoc.data()) === null || _a === void 0 ? void 0 : _a.photoURL
            });
        });
        await Promise.all(creatorPromises);
        // Notify Opponent's Followers
        const opponentFollowers = await firebase_1.db.collection("users").doc(opponentId).collection("followers").limit(100).get();
        const opponentPromises = opponentFollowers.docs.map(doc => {
            var _a;
            return (0, utils_1.createNotification)(doc.id, {
                title: "Battle Alert! ⚔️",
                body: `${opponentName} started a battle with ${creatorName}.`,
                type: "contest-watch",
                targetId: matchId,
                image: (_a = opponentDoc.data()) === null || _a === void 0 ? void 0 : _a.photoURL
            });
        });
        await Promise.all(opponentPromises);
    }
    // Status changed to 'finished'
    if (oldData.status !== 'finished' && newData.status === 'finished') {
        const winnerId = newData.winnerId;
        if (winnerId) {
            await (0, utils_1.createNotification)(winnerId, {
                title: "You Won! 🏆",
                body: "Congratulations! You won the battle.",
                type: "contest-win",
                targetId: matchId
            });
        }
        const participants = [newData.creatorId, newData.opponentId];
        const loserId = participants.find(id => id !== winnerId);
        if (loserId) {
            await (0, utils_1.createNotification)(loserId, {
                title: "Battle Ended",
                body: "The battle has ended. Check the results.",
                type: "contest-end",
                targetId: matchId
            });
        }
    }
});
// 8. Wallet Transaction Notifications (Expanded)
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
            return; // Don't notify for unknown types
    }
    await (0, utils_1.createNotification)(userId, {
        title,
        body,
        type: "wallet",
        targetId: "wallet"
    });
});
// 9. User Follow Notification & Milestones
exports.onUserFollow = (0, firestore_1.onDocumentCreated)("users/{userId}/followers/{followerId}", async (event) => {
    const snapshot = event.data;
    if (!snapshot)
        return;
    const { userId, followerId } = event.params;
    const followerDoc = await firebase_1.db.collection("users").doc(followerId).get();
    if (!followerDoc.exists)
        return;
    const followerData = followerDoc.data();
    const followerName = (followerData === null || followerData === void 0 ? void 0 : followerData.username) || "Someone";
    await (0, utils_1.createNotification)(userId, {
        title: "New Follower! 🌟",
        body: `${followerName} started following you.`,
        type: "follow",
        targetId: followerId,
        image: followerData === null || followerData === void 0 ? void 0 : followerData.photoURL
    });
    const userRef = firebase_1.db.collection("users").doc(userId);
    const userDoc = await userRef.get();
    const userData = userDoc.data();
    const currentFollowers = ((userData === null || userData === void 0 ? void 0 : userData.followersCount) || 0) + 1;
    await userRef.update({ followersCount: currentFollowers });
    const milestones = [10, 50, 100, 500, 1000, 5000];
    if (milestones.includes(currentFollowers)) {
        await (0, utils_1.createNotification)(userId, {
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
        const sharerDoc = await firebase_1.db.collection("users").doc(sharedBy).get();
        const sharerName = ((_a = sharerDoc.data()) === null || _a === void 0 ? void 0 : _a.username) || "Someone";
        await (0, utils_1.createNotification)(userId, {
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
    const visitorDoc = await firebase_1.db.collection("users").doc(visitorId).get();
    const visitorName = ((_a = visitorDoc.data()) === null || _a === void 0 ? void 0 : _a.username) || "Someone";
    await (0, utils_1.createNotification)(userId, {
        title: "New Profile Visitor 👀",
        body: `${visitorName} viewed your profile.`,
        type: "profile-visit",
        targetId: visitorId,
        image: (_b = visitorDoc.data()) === null || _b === void 0 ? void 0 : _b.photoURL
    });
});
// 12. User Level Up Trigger (Based on XP)
exports.onUserLevelUp = (0, firestore_1.onDocumentUpdated)("users/{userId}", async (event) => {
    const change = event.data;
    if (!change)
        return;
    const oldData = change.before.data();
    const newData = change.after.data();
    const oldXp = oldData.xp || 0;
    const newXp = newData.xp || 0;
    // Assuming 1000 XP = 1 Level
    const oldLevel = Math.floor(oldXp / 1000);
    const newLevel = Math.floor(newXp / 1000);
    if (newLevel > oldLevel) {
        await (0, utils_1.createNotification)(event.params.userId, {
            title: "Level Up! 🆙",
            body: `Congratulations! You reached Level ${newLevel}. Keep battling!`,
            type: "level-up",
            targetId: "profile",
            image: newData.photoURL
        });
    }
});
//# sourceMappingURL=triggers.js.map