import { onCall, HttpsError } from "firebase-functions/v2/https";
import { db } from "../utils/firebase";
import { FieldValue } from "firebase-admin/firestore";
import { awardXp } from "../utils/gamification";

/**
 * Submit a vote for a participant in a contest match
 * Logic: 1 vote per account, max 5 votes per Device ID for the same match.
 */
export const submitVote = onCall(async (request) => {
  const { auth } = request;
  if (!auth) {
    throw new HttpsError("unauthenticated", "User must be logged in.");
  }

  const { matchId, votedForUid, deviceId } = request.data;

  if (!matchId || !votedForUid || !deviceId) {
    throw new HttpsError("invalid-argument", "Missing matchId, votedForUid, or deviceId.");
  }

  const voterUid = auth.uid;
  const matchRef = db.collection("contestMatches").doc(matchId);
  const voteRef = db.collection("votes").doc(`${matchId}_${voterUid}`);
  
  // Reference to track votes per device for this specific match
  const deviceCounterRef = db.collection("contestMatches").doc(matchId)
    .collection("deviceVoteCounts").doc(deviceId);

  try {
    await db.runTransaction(async (transaction) => {
      // 1. Get Match Data
      const matchDoc = await transaction.get(matchRef);
      if (!matchDoc.exists) throw new HttpsError("not-found", "Match not found.");
      
      const matchData = matchDoc.data()!;
      if (matchData.status !== "active") throw new HttpsError("failed-precondition", "Battle is not active.");

      // 2. Check if this specific ACCOUNT has already voted
      const voteDoc = await transaction.get(voteRef);
      if (voteDoc.exists) throw new HttpsError("already-exists", "You have already voted in this match.");

      // 3. ANTI-CHEAT: Check if this DEVICE has already voted 5 times
      const deviceDoc = await transaction.get(deviceCounterRef);
      const deviceVoteCount = deviceDoc.exists ? (deviceDoc.data()?.count || 0) : 0;

      if (deviceVoteCount >= 5) {
        throw new HttpsError("resource-exhausted", "Device limit reached! Maximum 5 votes allowed per device for this match.");
      }

      // 4. Participants cannot vote for themselves
      if (voterUid === matchData.userA.uid || (matchData.userB && voterUid === matchData.userB.uid)) {
        throw new HttpsError("failed-precondition", "Participants cannot vote in their own match.");
      }

      // 5. Calculate vote updates
      let updateData: any = {
        totalVotes: FieldValue.increment(1)
      };

      if (votedForUid === matchData.userA.uid) {
        updateData["userA.votes"] = FieldValue.increment(1);
      } else if (matchData.userB && votedForUid === matchData.userB.uid) {
        updateData["userB.votes"] = FieldValue.increment(1);
      } else {
        throw new HttpsError("invalid-argument", "Invalid participant UID for this match.");
      }

      // --- ATOMIC UPDATES ---
      
      // Update Match Votes
      transaction.update(matchRef, updateData);

      // Update/Create Device Counter
      if (deviceDoc.exists) {
        transaction.update(deviceCounterRef, { count: FieldValue.increment(1) });
      } else {
        transaction.set(deviceCounterRef, { count: 1, matchId, deviceId, updatedAt: FieldValue.serverTimestamp() });
      }

      // Record Account Vote
      transaction.set(voteRef, {
        matchId,
        voterUid,
        votedForUid,
        deviceId,
        timestamp: FieldValue.serverTimestamp()
      });
    });

    // Award XP for voting
    await awardXp(voterUid, 5, "voted_in_contest");

    return { success: true };
  } catch (error: any) {
    console.error("Error in submitVote:", error);
    if (error instanceof HttpsError) throw error;
    throw new HttpsError("internal", error.message || "Voting failed.");
  }
});
