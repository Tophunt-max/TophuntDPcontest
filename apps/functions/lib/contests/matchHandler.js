"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.joinContestMatch = exports.startContestMatch = void 0;
const https_1 = require("firebase-functions/v2/https");
const firebase_1 = require("../utils/firebase");
const firestore_1 = require("firebase-admin/firestore");
const sender_1 = require("../notifications/sender");
// Helper function to generate a unique short Join ID
const generateJoinId = () => {
    return "JN-" + Math.random().toString(36).substring(2, 8).toUpperCase();
};
/**
 * Start a new contest match (User A)
 */
exports.startContestMatch = (0, https_1.onCall)(async (request) => {
    const { auth } = request;
    if (!auth)
        throw new https_1.HttpsError("unauthenticated", "User must be logged in.");
    const { contestId, mediaUrl, mediaType, caption, deviceId, invitedUid } = request.data;
    const uid = auth.uid;
    try {
        const result = await firebase_1.db.runTransaction(async (transaction) => {
            const contestRef = firebase_1.db.collection("contests").doc(contestId);
            const userRef = firebase_1.db.collection("users").doc(uid);
            const contestDoc = await transaction.get(contestRef);
            const userDoc = await transaction.get(userRef);
            if (!contestDoc.exists)
                throw new https_1.HttpsError("not-found", "Contest template not found.");
            if (!userDoc.exists)
                throw new https_1.HttpsError("not-found", "User document not found.");
            const contestData = contestDoc.data();
            const userData = userDoc.data();
            // Calculate split entry fee (50% for each user) - Rounding up to prevent odd-coin leakage
            const totalFee = Number(contestData.totalEntryFee || contestData.entryDpcoin || 0);
            const entryFeePerUser = Math.ceil(totalFee / 2);
            const userBalance = Number(userData.Dpcoin || 0);
            if (userBalance < entryFeePerUser) {
                throw new https_1.HttpsError("failed-precondition", `Insufficient Dpcoin. Required: ${entryFeePerUser}, Current: ${userBalance}`);
            }
            transaction.update(userRef, {
                Dpcoin: firestore_1.FieldValue.increment(-entryFeePerUser),
                xp: firestore_1.FieldValue.increment(10),
            });
            // Record transaction
            const transRef = firebase_1.db.collection("coinTransactions").doc();
            transaction.set(transRef, {
                uid,
                amount: -entryFeePerUser,
                type: "contest_entry_fee",
                contestId,
                timestamp: firestore_1.FieldValue.serverTimestamp(),
                description: `Entry fee (50% split) for ${contestData.title || 'contest'}`
            });
            const matchRef = firebase_1.db.collection("contestMatches").doc();
            const joinIdA = generateJoinId();
            const expiresAt = new Date();
            expiresAt.setHours(expiresAt.getHours() + (contestData.autoCancelHours || 24));
            transaction.set(matchRef, {
                id: matchRef.id,
                contestId,
                status: "waiting_for_opponent",
                type: contestData.type || 'photo',
                title: contestData.title || contestData.name || "Untitled Contest",
                entryFee: totalFee,
                isPrivate: !!invitedUid,
                invitedUid: invitedUid || null,
                joinIdA: joinIdA,
                joinIdB: null,
                joinIds: [joinIdA],
                userA: {
                    uid,
                    joinId: joinIdA,
                    username: userData.username || "Anonymous",
                    profilePic: userData.profileImageUrl || userData.profilePic || "",
                    mediaUrl,
                    mediaType: mediaType || 'photo',
                    caption: caption || "",
                    votes: 0,
                    joinedAt: firestore_1.FieldValue.serverTimestamp(),
                    deviceId: deviceId || "",
                },
                userB: null,
                totalVotes: 0,
                likeCount: 0,
                commentCount: 0,
                shareCount: 0,
                createdAt: firestore_1.FieldValue.serverTimestamp(),
                expiresAt: firebase_1.admin.firestore.Timestamp.fromDate(expiresAt),
            });
            return {
                matchId: matchRef.id,
                joinId: joinIdA,
                username: userData.username,
                profilePic: userData.profileImageUrl || userData.profilePic,
                contestTitle: contestData.title || contestData.name
            };
        });
        // AUTO-CREATE STORY
        try {
            await firebase_1.db.collection("stories").add({
                userId: uid,
                username: result.username || "Anonymous",
                avatarUrl: result.profilePic || "",
                mediaUrl: mediaUrl,
                mediaType: mediaType || 'photo',
                type: 'contest_announcement',
                matchId: result.matchId,
                contestTitle: result.contestTitle || "Contest",
                createdAt: firebase_1.admin.firestore.FieldValue.serverTimestamp(),
                expiresAt: firebase_1.admin.firestore.Timestamp.fromDate(new Date(Date.now() + 24 * 60 * 60 * 1000)),
            });
        }
        catch (e) {
            console.error("Story creation failed:", e);
        }
        return { matchId: result.matchId, joinId: result.joinId };
    }
    catch (error) {
        console.error("[startContestMatch] Error:", error);
        if (error instanceof https_1.HttpsError)
            throw error;
        throw new https_1.HttpsError("internal", error.message || "Failed to start match");
    }
});
/**
 * Join an existing contest match (User B)
 */
exports.joinContestMatch = (0, https_1.onCall)(async (request) => {
    const { auth } = request;
    if (!auth)
        throw new https_1.HttpsError("unauthenticated", "User must be logged in.");
    const { matchId, mediaUrl, mediaType, caption, deviceId } = request.data;
    const uid = auth.uid;
    try {
        const result = await firebase_1.db.runTransaction(async (transaction) => {
            const matchRef = firebase_1.db.collection("contestMatches").doc(matchId);
            const userRef = firebase_1.db.collection("users").doc(uid);
            const matchDoc = await transaction.get(matchRef);
            const userDoc = await transaction.get(userRef);
            if (!matchDoc.exists)
                throw new https_1.HttpsError("not-found", "Match not found.");
            if (!userDoc.exists)
                throw new https_1.HttpsError("not-found", "User document not found.");
            const matchData = matchDoc.data();
            // 1. Validation Checks
            if (matchData.status !== "waiting_for_opponent")
                throw new https_1.HttpsError("failed-precondition", "Match unavailable.");
            if (matchData.userA.uid === uid)
                throw new https_1.HttpsError("failed-precondition", "You cannot join your own match.");
            // Anti-Cheat: Device ID Check
            if (deviceId && matchData.userA.deviceId === deviceId) {
                throw new https_1.HttpsError("permission-denied", "Multi-account detected. You cannot join matches from the same device.");
            }
            // Expiry Check
            if (matchData.expiresAt && matchData.expiresAt.toMillis() < Date.now()) {
                throw new https_1.HttpsError("failed-precondition", "This match has expired.");
            }
            const userData = userDoc.data();
            const entryFeePerUser = Math.ceil(Number(matchData.entryFee || 0) / 2);
            const userBalance = Number(userData.Dpcoin || 0);
            if (userBalance < entryFeePerUser) {
                throw new https_1.HttpsError("failed-precondition", `Insufficient Dpcoin. Required: ${entryFeePerUser}, Current: ${userBalance}`);
            }
            const joinIdB = generateJoinId();
            transaction.update(userRef, {
                Dpcoin: firestore_1.FieldValue.increment(-entryFeePerUser),
                xp: firestore_1.FieldValue.increment(10),
            });
            // Record transaction
            const transRef = firebase_1.db.collection("coinTransactions").doc();
            transaction.set(transRef, {
                uid,
                amount: -entryFeePerUser,
                type: "contest_entry_fee",
                matchId: matchId,
                contestId: matchData.contestId,
                timestamp: firestore_1.FieldValue.serverTimestamp(),
                description: `Entry fee (50% split) for ${matchData.title || 'contest'}`
            });
            transaction.update(matchRef, {
                status: "active",
                joinIdB: joinIdB,
                joinIds: [matchData.joinIdA, joinIdB],
                userB: {
                    uid,
                    joinId: joinIdB,
                    username: userData.username || "Anonymous",
                    profilePic: userData.profileImageUrl || userData.profilePic || "",
                    mediaUrl,
                    mediaType: mediaType || 'photo',
                    caption: caption || "",
                    votes: 0,
                    joinedAt: firestore_1.FieldValue.serverTimestamp(),
                    deviceId: deviceId || "",
                },
                activatedAt: firestore_1.FieldValue.serverTimestamp(),
            });
            return {
                userAId: matchData.userA.uid,
                userBName: userData.username,
                userBPic: userData.profileImageUrl || userData.profilePic,
                matchTitle: matchData.title,
                joinId: joinIdB
            };
        });
        // AUTO-CREATE STORY
        try {
            await firebase_1.db.collection("stories").add({
                userId: uid,
                username: result.userBName || "Anonymous",
                avatarUrl: result.userBPic || "",
                mediaUrl: mediaUrl,
                mediaType: mediaType || 'photo',
                type: 'contest_match_live',
                matchId: matchId,
                contestTitle: result.matchTitle || "Contest",
                createdAt: firebase_1.admin.firestore.FieldValue.serverTimestamp(),
                expiresAt: firebase_1.admin.firestore.Timestamp.fromDate(new Date(Date.now() + 24 * 60 * 60 * 1000)),
            });
        }
        catch (e) {
            console.error("Story creation failed:", e);
        }
        await (0, sender_1.sendPushNotification)(result.userAId, "Match Live! 🚀", `${result.userBName} has joined your battle "${result.matchTitle}". Voting is now open!`, "match_active", { matchId });
        return { status: "active", joinId: result.joinId };
    }
    catch (error) {
        console.error("[joinContestMatch] Error:", error);
        if (error instanceof https_1.HttpsError)
            throw error;
        throw new https_1.HttpsError("internal", error.message || "Failed to join match");
    }
});
//# sourceMappingURL=matchHandler.js.map