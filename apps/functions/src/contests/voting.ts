import { onCall, HttpsError } from "firebase-functions/v2/https";
import { db } from "../utils/firebase";
import { FieldValue } from "firebase-admin/firestore";
import { awardXp } from "../utils/gamification";

/**
 * Submit a vote for a participant in a match
 */
export const submitVote = onCall(async (request) => {
  const { auth } = request;
  if (!auth) {
    throw new HttpsError("unauthenticated", "User must be logged in.");
  }

  const { matchId, votedForUid, deviceId } = request.data;

  if (!matchId || !votedForUid || !deviceId) {
    throw new HttpsError("invalid-argument", "Missing required fields.");
  }

  const voterUid = auth.uid;
  const matchRef = db.collection("contestMatches").doc(matchId);
  const voteRef = db.collection("votes").doc(`${matchId}_${voterUid}`);

  await db.runTransaction(async (transaction) => {
    const matchDoc = await transaction.get(matchRef);
    const voteDoc = await transaction.get(voteRef);

    if (!matchDoc.exists) throw new HttpsError("not-found", "Match not found.");
    if (voteDoc.exists) throw new HttpsError("already-exists", "Already voted.");

    const matchData = matchDoc.data()!;
    if (matchData.status !== "active") throw new HttpsError("failed-precondition", "Battle is not active.");

    if (voterUid === matchData.userA.uid || voterUid === matchData.userB.uid) {
      throw new HttpsError("failed-precondition", "Participants cannot vote.");
    }

    // Update match
    const voteField = votedForUid === matchData.userA.uid ? "userA.votes" : "userB.votes";
    transaction.update(matchRef, {
      [voteField]: FieldValue.increment(1),
      totalVotes: FieldValue.increment(1)
    });

    transaction.set(voteRef, {
      matchId,
      voterUid,
      votedForUid,
      deviceId,
      timestamp: FieldValue.serverTimestamp()
    });
  });

  // Award XP for voting (using the separate utility)
  await awardXp(voterUid, 5, "voted_in_contest");

  return { success: true };
});
