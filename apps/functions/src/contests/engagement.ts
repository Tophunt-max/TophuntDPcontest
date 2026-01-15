import { onCall, HttpsError } from "firebase-functions/v2/https";
import { db } from "../utils/firebase";
import { FieldValue } from "firebase-admin/firestore";
import { awardXp } from "../utils/gamification";
import { sendPushNotification } from "../notifications/sender";

/**
 * Toggles a like on a contest MATCH (Battle)
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
    const result = await db.runTransaction(async (transaction) => {
      const matchDoc = await transaction.get(matchRef);
      const likeDoc = await transaction.get(likeRef);

      if (!matchDoc.exists) throw new HttpsError("not-found", "Match not found.");
      
      const matchData = matchDoc.data()!;
      if (matchData.status !== "active") throw new HttpsError("failed-precondition", "Engagement only allowed on active battles.");

      if (likeDoc.exists) {
        transaction.update(matchRef, { likeCount: FieldValue.increment(-1) });
        transaction.delete(likeRef);
        isLiking = false;
      } else {
        transaction.update(matchRef, { likeCount: FieldValue.increment(1) });
        transaction.set(likeRef, { userId: likerUid, timestamp: FieldValue.serverTimestamp() });
        isLiking = true;
      }
      
      return { matchData, isLiking };
    });

    if (isLiking) {
        // Only award XP once per match (Optional: could track in user profile, but simple for now)
        await awardXp(likerUid, 2, "liked_a_battle");
        
        // Notify participants
        const participants = [result.matchData.userA.uid];
        if (result.matchData.userB) participants.push(result.matchData.userB.uid);
        
        for (const pid of participants) {
            if (pid !== likerUid) {
                await sendPushNotification(pid, "New Like! ❤️", `Someone liked your battle "${result.matchData.title}"`, "engagement", { matchId });
            }
        }
    }
    
    return { success: true, action: isLiking ? 'liked' : 'unliked' };
  } catch (error: any) {
    console.error("Error in likeContest:", error);
    if (error instanceof HttpsError) throw error;
    throw new HttpsError("internal", error.message);
  }
});

/**
 * Adds a comment to a contest MATCH (Battle)
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
    const result = await db.runTransaction(async (transaction) => {
      const matchDoc = await transaction.get(matchRef);
      if (!matchDoc.exists) throw new HttpsError("not-found", "Match not found.");
      
      const matchData = matchDoc.data()!;
      if (matchData.status !== "active") throw new HttpsError("failed-precondition", "Engagement only allowed on active battles.");

      transaction.update(matchRef, { commentCount: FieldValue.increment(1) });
      transaction.set(commentRef, {
        userId: commenterUid,
        text: text,
        timestamp: FieldValue.serverTimestamp(),
      });
      
      return { matchData };
    });
    
    await awardXp(commenterUid, 3, "commented_on_a_battle");
    
    // Notify participants
    const participants = [result.matchData.userA.uid];
    if (result.matchData.userB) participants.push(result.matchData.userB.uid);
    
    for (const pid of participants) {
        if (pid !== commenterUid) {
            await sendPushNotification(pid, "New Comment! 💬", `Someone commented on your battle: "${text.substring(0, 30)}..."`, "engagement", { matchId });
        }
    }

    return { success: true, commentId: commentRef.id };
  } catch (error: any) {
    console.error("Error in commentOnContest:", error);
    if (error instanceof HttpsError) throw error;
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
    const matchDoc = await matchRef.get();
    if (!matchDoc.exists) throw new HttpsError("not-found", "Match not found.");
    if (matchDoc.data()?.status !== "active") throw new HttpsError("failed-precondition", "Battle is not active.");

    await matchRef.update({ shareCount: FieldValue.increment(1) });
    
    // Safety check: Don't award too much XP for repetitive sharing (Basic logic)
    // In production, you might want a 'shares' subcollection to track unique shares.
    await awardXp(sharerUid, 4, "shared_a_battle");
    
    return { success: true };
  } catch (error: any) {
    console.error("Error in shareContest:", error);
    throw new HttpsError("internal", error.message);
  }
});
