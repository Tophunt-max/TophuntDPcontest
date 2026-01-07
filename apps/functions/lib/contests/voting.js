"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.submitVote = void 0;
const https_1 = require("firebase-functions/v2/https");
const firebase_1 = require("../utils/firebase");
const firestore_1 = require("firebase-admin/firestore");
const gamification_1 = require("../utils/gamification");
/**
 * Submit a vote for a participant in a contest match
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
    try {
        await firebase_1.db.runTransaction(async (transaction) => {
            const matchDoc = await transaction.get(matchRef);
            const voteDoc = await transaction.get(voteRef);
            if (!matchDoc.exists)
                throw new https_1.HttpsError("not-found", "Match not found.");
            if (voteDoc.exists)
                throw new https_1.HttpsError("already-exists", "You have already voted in this match.");
            const matchData = matchDoc.data();
            if (matchData.status !== "active")
                throw new https_1.HttpsError("failed-precondition", "Battle is not active.");
            if (voterUid === matchData.userA.uid || (matchData.userB && voterUid === matchData.userB.uid)) {
                throw new https_1.HttpsError("failed-precondition", "Participants cannot vote in their own match.");
            }
            // Update match votes based on participant UID
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
            transaction.update(matchRef, updateData);
            // Record the vote to prevent double voting
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