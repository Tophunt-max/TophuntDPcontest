"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.joinContestMatch = exports.startContestMatch = void 0;
const https_1 = require("firebase-functions/v2/https");
const firebase_1 = require("../utils/firebase");
const firestore_1 = require("firebase-admin/firestore");
const sender_1 = require("../notifications/sender");
/**
 * Start a new contest match (User A)
 */
exports.startContestMatch = (0, https_1.onCall)(async (request) => {
    const { auth } = request;
    if (!auth)
        throw new https_1.HttpsError("unauthenticated", "User must be logged in.");
    const { contestId, mediaUrl, mediaType, caption, deviceId, invitedUid } = request.data;
    const uid = auth.uid;
    console.log(`[startContestMatch] User ${uid} starting match for contest ${contestId}`);
    try {
        const result = await firebase_1.db.runTransaction(async (transaction) => {
            const contestRef = firebase_1.db.collection("contests").doc(contestId);
            const userRef = firebase_1.db.collection("users").doc(uid);
            const contestDoc = await transaction.get(contestRef);
            const userDoc = await transaction.get(userRef);
            if (!contestDoc.exists)
                throw new https_1.HttpsError("not-found", "Contest not found.");
            if (!userDoc.exists)
                throw new https_1.HttpsError("not-found", "User document not found.");
            const contestData = contestDoc.data();
            const userData = userDoc.data();
            // Calculate split entry fee (50% for each user)
            const totalFee = Number(contestData.totalEntryFee || contestData.entryFishCoins || contestData.entryDpcoin || 0);
            const entryFeePerUser = totalFee / 2;
            const userBalance = Number(userData.Dpcoin || userData.fishCoins || userData.coins || 0);
            if (userBalance < entryFeePerUser) {
                throw new https_1.HttpsError("failed-precondition", `Insufficient balance. Required: ${entryFeePerUser}, Current: ${userBalance}`);
            }
            // Determine which coin field to deduct from (prefer 'Dpcoin' if it exists, fallback to others)
            let coinField = "Dpcoin";
            if (userData.Dpcoin === undefined) {
                if (userData.fishCoins !== undefined)
                    coinField = "fishCoins";
                else if (userData.coins !== undefined)
                    coinField = "coins";
            }
            transaction.update(userRef, {
                [coinField]: firestore_1.FieldValue.increment(-entryFeePerUser),
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
            const expiresAt = new Date();
            expiresAt.setHours(expiresAt.getHours() + (contestData.autoCancelHours || 24));
            const isPrivate = !!invitedUid;
            transaction.set(matchRef, {
                contestId,
                status: "waiting_for_opponent",
                type: contestData.type || 'photo',
                title: contestData.title || contestData.name || "Untitled Contest",
                entryFee: totalFee, // Store the FULL entry fee for reference
                isPrivate: isPrivate,
                invitedUid: invitedUid || null,
                userA: {
                    uid,
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
                createdAt: firestore_1.FieldValue.serverTimestamp(),
                expiresAt: firebase_1.admin.firestore.Timestamp.fromDate(expiresAt),
            });
            return {
                matchId: matchRef.id,
                username: userData.username,
                profilePic: userData.profileImageUrl || userData.profilePic,
                contestTitle: contestData.title || contestData.name
            };
        });
        // AUTO-CREATE STORY (User A started a match)
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
        return { matchId: result.matchId };
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
    console.log(`[joinContestMatch] User ${uid} joining match ${matchId}`);
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
            if (matchData.status !== "waiting_for_opponent")
                throw new https_1.HttpsError("failed-precondition", "Match unavailable.");
            if (matchData.userA.uid === uid)
                throw new https_1.HttpsError("failed-precondition", "You cannot join your own match.");
            const userData = userDoc.data();
            // Calculate split entry fee (remaining 50% for User B)
            const totalFee = Number(matchData.entryFee || 0);
            const entryFeePerUser = totalFee / 2;
            const userBalance = Number(userData.Dpcoin || userData.fishCoins || userData.coins || 0);
            if (userBalance < entryFeePerUser) {
                throw new https_1.HttpsError("failed-precondition", `Insufficient balance. Required: ${entryFeePerUser}, Current: ${userBalance}`);
            }
            // Determine which coin field to deduct from
            let coinField = "Dpcoin";
            if (userData.Dpcoin === undefined) {
                if (userData.fishCoins !== undefined)
                    coinField = "fishCoins";
                else if (userData.coins !== undefined)
                    coinField = "coins";
            }
            transaction.update(userRef, {
                [coinField]: firestore_1.FieldValue.increment(-entryFeePerUser),
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
                userB: {
                    uid,
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
                matchTitle: matchData.title
            };
        });
        // AUTO-CREATE STORY (User B joined - Match is now LIVE)
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
        return { status: "active" };
    }
    catch (error) {
        console.error("[joinContestMatch] Error:", error);
        if (error instanceof https_1.HttpsError)
            throw error;
        throw new https_1.HttpsError("internal", error.message || "Failed to join match");
    }
});
//# sourceMappingURL=matchHandler.js.map