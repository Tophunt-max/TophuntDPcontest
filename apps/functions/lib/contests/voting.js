"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.submitVote = void 0;
const https_1 = require("firebase-functions/v2/https");
const firebase_1 = require("../utils/firebase");
const firestore_1 = require("firebase-admin/firestore");
const gamification_1 = require("../utils/gamification");
/**
 * Submit a vote for a participant in a contest match
 * Logic: 1 vote per account, max 5 votes per Device ID for the same match.
 */
exports.submitVote = (0, https_1.onCall)(async (request) => {
    const { auth } = request;
    if (!auth) {
        throw new https_1.HttpsError("unauthenticated", "User must be logged in.");
    }
    const { matchId, votedForUid, deviceId } = request.data;
    if (!matchId || !votedForUid || !deviceId) {
        throw new https_1.HttpsError("invalid-argument", "Missing matchId, votedForUid, or deviceId.");
    }
    const voterUid = auth.uid;
    const matchRef = firebase_1.db.collection("contestMatches").doc(matchId);
    const voteRef = firebase_1.db.collection("votes").doc(`${matchId}_${voterUid}`);
    // Reference to track votes per device for this specific match
    const deviceCounterRef = firebase_1.db.collection("contestMatches").doc(matchId)
        .collection("deviceVoteCounts").doc(deviceId);
    try {
        await firebase_1.db.runTransaction(async (transaction) => {
            var _a;
            // 1. Get Match Data
            const matchDoc = await transaction.get(matchRef);
            if (!matchDoc.exists)
                throw new https_1.HttpsError("not-found", "Match not found.");
            const matchData = matchDoc.data();
            if (matchData.status !== "active")
                throw new https_1.HttpsError("failed-precondition", "Battle is not active.");
            // 2. Check if this specific ACCOUNT has already voted
            const voteDoc = await transaction.get(voteRef);
            if (voteDoc.exists)
                throw new https_1.HttpsError("already-exists", "You have already voted in this match.");
            // 3. ANTI-CHEAT: Check if this DEVICE has already voted 5 times
            const deviceDoc = await transaction.get(deviceCounterRef);
            const deviceVoteCount = deviceDoc.exists ? (((_a = deviceDoc.data()) === null || _a === void 0 ? void 0 : _a.count) || 0) : 0;
            if (deviceVoteCount >= 5) {
                throw new https_1.HttpsError("resource-exhausted", "Device limit reached! Maximum 5 votes allowed per device for this match.");
            }
            // 4. Participants cannot vote for themselves
            if (voterUid === matchData.userA.uid || (matchData.userB && voterUid === matchData.userB.uid)) {
                throw new https_1.HttpsError("failed-precondition", "Participants cannot vote in their own match.");
            }
            // 5. Calculate vote updates
            let updateData = {
                totalVotes: firestore_1.FieldValue.increment(1)
            };
            if (votedForUid === matchData.userA.uid) {
                updateData["userA.votes"] = firestore_1.FieldValue.increment(1);
            }
            else if (matchData.userB && votedForUid === matchData.userB.uid) {
                updateData["userB.votes"] = firestore_1.FieldValue.increment(1);
            }
            else {
                throw new https_1.HttpsError("invalid-argument", "Invalid participant UID for this match.");
            }
            // --- ATOMIC UPDATES ---
            // Update Match Votes
            transaction.update(matchRef, updateData);
            // Update/Create Device Counter
            if (deviceDoc.exists) {
                transaction.update(deviceCounterRef, { count: firestore_1.FieldValue.increment(1) });
            }
            else {
                transaction.set(deviceCounterRef, { count: 1, matchId, deviceId, updatedAt: firestore_1.FieldValue.serverTimestamp() });
            }
            // Record Account Vote
            transaction.set(voteRef, {
                matchId,
                voterUid,
                votedForUid,
                deviceId,
                timestamp: firestore_1.FieldValue.serverTimestamp()
            });
        });
        // Award XP for voting
        await (0, gamification_1.awardXp)(voterUid, 5, "voted_in_contest");
        return { success: true };
    }
    catch (error) {
        console.error("Error in submitVote:", error);
        if (error instanceof https_1.HttpsError)
            throw error;
        throw new https_1.HttpsError("internal", error.message || "Voting failed.");
    }
});
//# sourceMappingURL=voting.js.map