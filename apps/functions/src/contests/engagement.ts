import { onCall, HttpsError } from "firebase-functions/v2/https";
import { db } from "../utils/firebase";
import { FieldValue } from "firebase-admin/firestore";
import { awardXp } from "../utils/gamification";

/**
 * Toggles a like on a contest.
 */
export const likeContest = onCall(async (request) => {
  const { auth } = request;
  if (!auth) {
    throw new HttpsError("unauthenticated", "User must be logged in.");
  }

  const { contestId } = request.data;
  if (!contestId) {
    throw new HttpsError("invalid-argument", "Missing contestId.");
  }

  const likerUid = auth.uid;
  const contestRef = db.collection("contests").doc(contestId);
  const likeRef = contestRef.collection("likes").doc(likerUid);

  let isLiking = false;

  await db.runTransaction(async (transaction) => {
    const contestDoc = await transaction.get(contestRef);
    const likeDoc = await transaction.get(likeRef);

    if (!contestDoc.exists) {
      throw new HttpsError("not-found", "Contest not found.");
    }

    if (likeDoc.exists) {
      // Unlike functionality
      transaction.update(contestRef, { likeCount: FieldValue.increment(-1) });
      transaction.delete(likeRef);
      isLiking = false;
    } else {
      // Like functionality
      transaction.update(contestRef, { likeCount: FieldValue.increment(1) });
      transaction.set(likeRef, {
        userId: likerUid,
        timestamp: FieldValue.serverTimestamp(),
      });
      isLiking = true;
    }
  });

  if (isLiking) {
    await awardXp(likerUid, 2, "liked_a_contest");
  }

  return { success: true, action: isLiking ? 'liked' : 'unliked' };
});

/**
 * Adds a comment to a contest.
 */
export const commentOnContest = onCall(async (request) => {
  const { auth } = request;
  if (!auth) {
    throw new HttpsError("unauthenticated", "User must be logged in.");
  }

  const { contestId, text } = request.data;
  if (!contestId || !text || text.trim() === '') {
    throw new HttpsError("invalid-argument", "Missing contestId or text.");
  }

  const commenterUid = auth.uid;
  const contestRef = db.collection("contests").doc(contestId);
  const commentRef = contestRef.collection("comments").doc();

  await db.runTransaction(async (transaction) => {
    const contestDoc = await transaction.get(contestRef);
    if (!contestDoc.exists) {
      throw new HttpsError("not-found", "Contest not found.");
    }

    transaction.update(contestRef, { commentCount: FieldValue.increment(1) });
    transaction.set(commentRef, {
      userId: commenterUid,
      text: text,
      timestamp: FieldValue.serverTimestamp(),
    });
  });
  
  await awardXp(commenterUid, 3, "commented_on_a_contest");

  return { success: true, commentId: commentRef.id };
});


/**
 * Increments the share count of a contest.
 */
export const shareContest = onCall(async (request) => {
  const { auth } = request;
  if (!auth) {
    throw new HttpsError("unauthenticated", "User must be logged in.");
  }

  const { contestId } = request.data;
  if (!contestId) {
    throw new HttpsError("invalid-argument", "Missing contestId.");
  }

  const sharerUid = auth.uid;
  const contestRef = db.collection("contests").doc(contestId);

  await contestRef.update({
    shareCount: FieldValue.increment(1)
  });

  await awardXp(sharerUid, 4, "shared_a_contest");

  return { success: true };
});
