import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";

/**
 * Vote for a participant in a VS battle.
 * Enforces one vote per user per battle.
 */
export const voteInBattle = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "User must be logged in.");
  }

  const { battleId, participantId } = request.data;
  const voterId = request.auth.uid;

  if (!battleId || !participantId) {
    throw new HttpsError("invalid-argument", "Missing battleId or participantId.");
  }

  const db = admin.firestore();

  try {
    return await db.runTransaction(async (transaction) => {
      const battleRef = db.collection("battles").doc(battleId);
      const battleDoc = await transaction.get(battleRef);

      if (!battleDoc.exists) {
        throw new HttpsError("not-found", "Battle not found.");
      }

      const battleData = battleDoc.data()!;
      if (battleData.status !== "active") {
        throw new HttpsError("failed-precondition", "This battle has already ended.");
      }

      // Check if contest is still live
      if (battleData.endDate.toDate() < new Date()) {
        throw new HttpsError("failed-precondition", "The contest for this battle has expired.");
      }

      // 1. Check if user already voted in this battle
      // Unique ID format: voterId_battleId
      const voteId = `${voterId}_${battleId}`;
      const voteRef = db.collection("votes").doc(voteId);
      const voteDoc = await transaction.get(voteRef);

      if (voteDoc.exists) {
        throw new HttpsError("already-exists", "You have already voted in this battle.");
      }

      // 2. Identify which side user voted for
      const isUserA = battleData.userA.userId === participantId;
      const isUserB = battleData.userB.userId === participantId;

      if (!isUserA && !isUserB) {
        throw new HttpsError("invalid-argument", "Invalid participant selected.");
      }

      // 3. Record the vote
      transaction.set(voteRef, {
        id: voteId,
        battleId,
        voterId,
        votedFor: participantId,
        contestId: battleData.contestId,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // 4. Update Vote Counts in Battle Document
      const updateData: any = {
        totalVotes: admin.firestore.FieldValue.increment(1),
      };

      if (isUserA) {
        updateData["userA.votes"] = admin.firestore.FieldValue.increment(1);
      } else {
        updateData["userB.votes"] = admin.firestore.FieldValue.increment(1);
      }

      transaction.update(battleRef, updateData);

      // 5. Update User's Stats (totalVotesReceived for the participant)
      const participantRef = db.collection("users").doc(participantId);
      transaction.update(participantRef, {
        "stats.totalVotesReceived": admin.firestore.FieldValue.increment(1)
      });

      return { success: true, message: "Vote recorded successfully!" };
    });
  } catch (error) {
    console.error("Error in voteInBattle:", error);
    if (error instanceof HttpsError) throw error;
    throw new HttpsError("internal", "Something went wrong while voting.");
  }
});
