"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.shareContest = exports.commentOnContest = exports.likeContest = void 0;
const https_1 = require("firebase-functions/v2/https");
const firebase_1 = require("../utils/firebase");
const firestore_1 = require("firebase-admin/firestore");
const gamification_1 = require("../utils/gamification");
/**
 * Toggles a like on a contest.
 */
exports.likeContest = (0, https_1.onCall)(async (request) => {
    const { auth } = request;
    if (!auth) {
        throw new https_1.HttpsError("unauthenticated", "User must be logged in.");
    }
    const { contestId } = request.data;
    if (!contestId) {
        throw new https_1.HttpsError("invalid-argument", "Missing contestId.");
    }
    const likerUid = auth.uid;
    const contestRef = firebase_1.db.collection("contests").doc(contestId);
    const likeRef = contestRef.collection("likes").doc(likerUid);
    let isLiking = false;
    await firebase_1.db.runTransaction(async (transaction) => {
        const contestDoc = await transaction.get(contestRef);
        const likeDoc = await transaction.get(likeRef);
        if (!contestDoc.exists) {
            throw new https_1.HttpsError("not-found", "Contest not found.");
        }
        if (likeDoc.exists) {
            // Unlike functionality
            transaction.update(contestRef, { likeCount: firestore_1.FieldValue.increment(-1) });
            transaction.delete(likeRef);
            isLiking = false;
        }
        else {
            // Like functionality
            transaction.update(contestRef, { likeCount: firestore_1.FieldValue.increment(1) });
            transaction.set(likeRef, {
                userId: likerUid,
                timestamp: firestore_1.FieldValue.serverTimestamp(),
            });
            isLiking = true;
        }
    });
    if (isLiking) {
        await (0, gamification_1.awardXp)(likerUid, 2, "liked_a_contest");
    }
    return { success: true, action: isLiking ? 'liked' : 'unliked' };
});
/**
 * Adds a comment to a contest.
 */
exports.commentOnContest = (0, https_1.onCall)(async (request) => {
    const { auth } = request;
    if (!auth) {
        throw new https_1.HttpsError("unauthenticated", "User must be logged in.");
    }
    const { contestId, text } = request.data;
    if (!contestId || !text || text.trim() === '') {
        throw new https_1.HttpsError("invalid-argument", "Missing contestId or text.");
    }
    const commenterUid = auth.uid;
    const contestRef = firebase_1.db.collection("contests").doc(contestId);
    const commentRef = contestRef.collection("comments").doc();
    await firebase_1.db.runTransaction(async (transaction) => {
        const contestDoc = await transaction.get(contestRef);
        if (!contestDoc.exists) {
            throw new https_1.HttpsError("not-found", "Contest not found.");
        }
        transaction.update(contestRef, { commentCount: firestore_1.FieldValue.increment(1) });
        transaction.set(commentRef, {
            userId: commenterUid,
            text: text,
            timestamp: firestore_1.FieldValue.serverTimestamp(),
        });
    });
    await (0, gamification_1.awardXp)(commenterUid, 3, "commented_on_a_contest");
    return { success: true, commentId: commentRef.id };
});
/**
 * Increments the share count of a contest.
 */
exports.shareContest = (0, https_1.onCall)(async (request) => {
    const { auth } = request;
    if (!auth) {
        throw new https_1.HttpsError("unauthenticated", "User must be logged in.");
    }
    const { contestId } = request.data;
    if (!contestId) {
        throw new https_1.HttpsError("invalid-argument", "Missing contestId.");
    }
    const sharerUid = auth.uid;
    const contestRef = firebase_1.db.collection("contests").doc(contestId);
    await contestRef.update({
        shareCount: firestore_1.FieldValue.increment(1)
    });
    await (0, gamification_1.awardXp)(sharerUid, 4, "shared_a_contest");
    return { success: true };
});
//# sourceMappingURL=engagement.js.map