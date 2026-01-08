"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.onMatchComment = exports.onMatchLike = exports.onPostComment = exports.onPostLike = void 0;
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
// 2. Post Comment Trigger
exports.onPostComment = (0, firestore_1.onDocumentCreated)("posts/{postId}/comments/{commentId}", async (event) => {
    var _a;
    const snapshot = event.data;
    if (!snapshot)
        return;
    const { postId } = event.params;
    const commentData = snapshot.data();
    const commenterId = commentData.userId;
    const postDoc = await firebase_1.db.collection("posts").doc(postId).get();
    if (!postDoc.exists)
        return;
    const postData = postDoc.data();
    const authorId = postData === null || postData === void 0 ? void 0 : postData.userId;
    if (authorId && authorId !== commenterId) {
        const commenterDoc = await firebase_1.db.collection("users").doc(commenterId).get();
        const commenterName = ((_a = commenterDoc.data()) === null || _a === void 0 ? void 0 : _a.username) || "Someone";
        await (0, utils_1.createNotification)(authorId, {
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
//# sourceMappingURL=triggers.js.map