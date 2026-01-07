import { onCall, HttpsError } from "firebase-functions/v2/https";
import { db } from "../utils/firebase";
import { FieldValue } from "firebase-admin/firestore";
import { awardXp } from "../utils/gamification";

/**
 * Toggles a like on a contest MATCH (Battle)
 * Engagement is joint for the match.
 */
export const likeContest = onCall(async (request) => {
  const { auth } = request;
  if (!auth) throw new HttpsError("unauthenticated", "User must be logged in.");

  const { matchId } = request.data;
  if (!matchId) throw new HttpsError("invalid-argument", "Missing matchId.");

  const likerUid = auth.uid;
  const matchRef = db.collection("contestMatches").doc(matchId);
  const likeRef = matchRef.collection("likes").doc(likerUid);

  let isLiking = false;

  try {
    await db.runTransaction(async (transaction) => {
      const matchDoc = await transaction.get(matchRef);
      const likeDoc = await transaction.get(likeRef);

      if (!matchDoc.exists) throw new HttpsError("not-found", "Match not found.");

      if (likeDoc.exists) {
        transaction.update(matchRef, { likeCount: FieldValue.increment(-1) });
        transaction.delete(likeRef);
        isLiking = false;
      } else {
        transaction.update(matchRef, { likeCount: FieldValue.increment(1) });
        transaction.set(likeRef, { userId: likerUid, timestamp: FieldValue.serverTimestamp() });
        isLiking = true;
      }
    });

    if (isLiking) await awardXp(likerUid, 2, "liked_a_battle");
    return { success: true, action: isLiking ? 'liked' : 'unliked' };
  } catch (error: any) {
    console.error("Error in likeContest:", error);
    throw new HttpsError("internal", error.message);
  }
});

/**
 * Adds a comment to a contest MATCH (Battle)
 * Engagement is joint for the match.
 */
export const commentOnContest = onCall(async (request) => {
  const { auth } = request;
  if (!auth) throw new HttpsError("unauthenticated", "User must be logged in.");

  const { matchId, text } = request.data;
  if (!matchId || !text) throw new HttpsError("invalid-argument", "Missing matchId or text.");

  const commenterUid = auth.uid;
  const matchRef = db.collection("contestMatches").doc(matchId);
  const commentRef = matchRef.collection("comments").doc();

  try {
    await db.runTransaction(async (transaction) => {
      const matchDoc = await transaction.get(matchRef);
      if (!matchDoc.exists) throw new HttpsError("not-found", "Match not found.");

      transaction.update(matchRef, { commentCount: FieldValue.increment(1) });
      transaction.set(commentRef, {
        userId: commenterUid,
        text: text,
        timestamp: FieldValue.serverTimestamp(),
      });
    });
    
    await awardXp(commenterUid, 3, "commented_on_a_battle");
    return { success: true, commentId: commentRef.id };
  } catch (error: any) {
    console.error("Error in commentOnContest:", error);
    throw new HttpsError("internal", error.message);
  }
});

/**
 * Increments the share count of a contest MATCH (Battle)
 */
export const shareContest = onCall(async (request) => {
  const { auth } = request;
  if (!auth) throw new HttpsError("unauthenticated", "User must be logged in.");

  const { matchId } = request.data;
  if (!matchId) throw new HttpsError("invalid-argument", "Missing matchId.");

  const sharerUid = auth.uid;
  const matchRef = db.collection("contestMatches").doc(matchId);

  try {
    await matchRef.update({ shareCount: FieldValue.increment(1) });
    await awardXp(sharerUid, 4, "shared_a_battle");
    return { success: true };
  } catch (error: any) {
    console.error("Error in shareContest:", error);
    throw new HttpsError("internal", error.message);
  }
});
