"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.shareContest = exports.commentOnContest = exports.likeContest = void 0;
const https_1 = require("firebase-functions/v2/https");
const firebase_1 = require("../utils/firebase");
const firestore_1 = require("firebase-admin/firestore");
const gamification_1 = require("../utils/gamification");
const sender_1 = require("../notifications/sender");
/**
 * Toggles a like on a contest MATCH (Battle)
 */
exports.likeContest = (0, https_1.onCall)(async (request) => {
    const { auth } = request;
    if (!auth)
        throw new https_1.HttpsError("unauthenticated", "User must be logged in.");
    const { matchId } = request.data;
    if (!matchId)
        throw new https_1.HttpsError("invalid-argument", "Missing matchId.");
    const likerUid = auth.uid;
    const matchRef = firebase_1.db.collection("contestMatches").doc(matchId);
    const likeRef = matchRef.collection("likes").doc(likerUid);
    let isLiking = false;
    try {
        const result = await firebase_1.db.runTransaction(async (transaction) => {
            const matchDoc = await transaction.get(matchRef);
            const likeDoc = await transaction.get(likeRef);
            if (!matchDoc.exists)
                throw new https_1.HttpsError("not-found", "Match not found.");
            const matchData = matchDoc.data();
            if (matchData.status !== "active")
                throw new https_1.HttpsError("failed-precondition", "Engagement only allowed on active battles.");
            if (likeDoc.exists) {
                transaction.update(matchRef, { likeCount: firestore_1.FieldValue.increment(-1) });
                transaction.delete(likeRef);
                isLiking = false;
            }
            else {
                transaction.update(matchRef, { likeCount: firestore_1.FieldValue.increment(1) });
                transaction.set(likeRef, { userId: likerUid, timestamp: firestore_1.FieldValue.serverTimestamp() });
                isLiking = true;
            }
            return { matchData, isLiking };
        });
        if (isLiking) {
            // Only award XP once per match (Optional: could track in user profile, but simple for now)
            await (0, gamification_1.awardXp)(likerUid, 2, "liked_a_battle");
            // Notify participants
            const participants = [result.matchData.userA.uid];
            if (result.matchData.userB)
                participants.push(result.matchData.userB.uid);
            for (const pid of participants) {
                if (pid !== likerUid) {
                    await (0, sender_1.sendPushNotification)(pid, "New Like! ❤️", `Someone liked your battle "${result.matchData.title}"`, "engagement", { matchId });
                }
            }
        }
        return { success: true, action: isLiking ? 'liked' : 'unliked' };
    }
    catch (error) {
        console.error("Error in likeContest:", error);
        if (error instanceof https_1.HttpsError)
            throw error;
        throw new https_1.HttpsError("internal", error.message);
    }
});
/**
 * Adds a comment to a contest MATCH (Battle)
 */
exports.commentOnContest = (0, https_1.onCall)(async (request) => {
    const { auth } = request;
    if (!auth)
        throw new https_1.HttpsError("unauthenticated", "User must be logged in.");
    const { matchId, text } = request.data;
    if (!matchId || !text)
        throw new https_1.HttpsError("invalid-argument", "Missing matchId or text.");
    const commenterUid = auth.uid;
    const matchRef = firebase_1.db.collection("contestMatches").doc(matchId);
    const commentRef = matchRef.collection("comments").doc();
    try {
        const result = await firebase_1.db.runTransaction(async (transaction) => {
            const matchDoc = await transaction.get(matchRef);
            if (!matchDoc.exists)
                throw new https_1.HttpsError("not-found", "Match not found.");
            const matchData = matchDoc.data();
            if (matchData.status !== "active")
                throw new https_1.HttpsError("failed-precondition", "Engagement only allowed on active battles.");
            transaction.update(matchRef, { commentCount: firestore_1.FieldValue.increment(1) });
            transaction.set(commentRef, {
                userId: commenterUid,
                text: text,
                timestamp: firestore_1.FieldValue.serverTimestamp(),
            });
            return { matchData };
        });
        await (0, gamification_1.awardXp)(commenterUid, 3, "commented_on_a_battle");
        // Notify participants
        const participants = [result.matchData.userA.uid];
        if (result.matchData.userB)
            participants.push(result.matchData.userB.uid);
        for (const pid of participants) {
            if (pid !== commenterUid) {
                await (0, sender_1.sendPushNotification)(pid, "New Comment! 💬", `Someone commented on your battle: "${text.substring(0, 30)}..."`, "engagement", { matchId });
            }
        }
        return { success: true, commentId: commentRef.id };
    }
    catch (error) {
        console.error("Error in commentOnContest:", error);
        if (error instanceof https_1.HttpsError)
            throw error;
        throw new https_1.HttpsError("internal", error.message);
    }
});
/**
 * Increments the share count of a contest MATCH (Battle)
 */
exports.shareContest = (0, https_1.onCall)(async (request) => {
    var _a;
    const { auth } = request;
    if (!auth)
        throw new https_1.HttpsError("unauthenticated", "User must be logged in.");
    const { matchId } = request.data;
    if (!matchId)
        throw new https_1.HttpsError("invalid-argument", "Missing matchId.");
    const sharerUid = auth.uid;
    const matchRef = firebase_1.db.collection("contestMatches").doc(matchId);
    try {
        const matchDoc = await matchRef.get();
        if (!matchDoc.exists)
            throw new https_1.HttpsError("not-found", "Match not found.");
        if (((_a = matchDoc.data()) === null || _a === void 0 ? void 0 : _a.status) !== "active")
            throw new https_1.HttpsError("failed-precondition", "Battle is not active.");
        await matchRef.update({ shareCount: firestore_1.FieldValue.increment(1) });
        // Safety check: Don't award too much XP for repetitive sharing (Basic logic)
        // In production, you might want a 'shares' subcollection to track unique shares.
        await (0, gamification_1.awardXp)(sharerUid, 4, "shared_a_battle");
        return { success: true };
    }
    catch (error) {
        console.error("Error in shareContest:", error);
        throw new https_1.HttpsError("internal", error.message);
    }
});
//# sourceMappingURL=engagement.js.map