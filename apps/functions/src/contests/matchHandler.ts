import { onCall, HttpsError } from "firebase-functions/v2/https";
import { db, admin } from "../utils/firebase";
import { FieldValue } from "firebase-admin/firestore";
import { sendPushNotification } from "../notifications/sender";

/**
 * Start a new contest match (User A)
 */
export const startContestMatch = onCall(async (request) => {
  const { auth } = request;
  if (!auth) throw new HttpsError("unauthenticated", "User must be logged in.");

  const { contestId, mediaUrl, mediaType, caption, deviceId, invitedUid } = request.data;
  const uid = auth.uid;

  console.log(`[startContestMatch] User ${uid} starting match for contest ${contestId}`);

  try {
    const result = await db.runTransaction(async (transaction) => {
      const contestRef = db.collection("contests").doc(contestId);
      const userRef = db.collection("users").doc(uid);
      
      const contestDoc = await transaction.get(contestRef);
      const userDoc = await transaction.get(userRef);

      if (!contestDoc.exists) throw new HttpsError("not-found", "Contest not found.");
      if (!userDoc.exists) throw new HttpsError("not-found", "User document not found.");

      const contestData = contestDoc.data()!;
      const userData = userDoc.data()!;
      
      // Support both naming conventions
      const totalFee = contestData.totalEntryFee || contestData.entryFishCoins || 0;
      const entryFee = totalFee / 2;

      if ((userData.coins || userData.fishCoins || 0) < entryFee) {
        throw new HttpsError("failed-precondition", "Insufficient coins.");
      }

      // Deduct coins
      const coinField = userData.coins !== undefined ? "coins" : "fishCoins";
      transaction.update(userRef, {
        [coinField]: FieldValue.increment(-entryFee),
        xp: FieldValue.increment(10),
      });

      const matchRef = db.collection("contestMatches").doc();
      const expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + (contestData.autoCancelHours || 24));

      const isPrivate = !!invitedUid; // If invitedUid is present, it's a private challenge

      transaction.set(matchRef, {
        contestId,
        status: "waiting_for_opponent",
        type: contestData.type || 'photo',
        title: contestData.title || contestData.name || "Untitled Contest",
        entryFee: totalFee,
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
          joinedAt: FieldValue.serverTimestamp(),
          deviceId: deviceId || "",
        },
        userB: null,
        totalVotes: 0,
        createdAt: FieldValue.serverTimestamp(),
        expiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
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
      await db.collection("stories").add({
        userId: uid,
        username: result.username || "Anonymous",
        avatarUrl: result.profilePic || "",
        mediaUrl: mediaUrl,
        mediaType: mediaType || 'photo',
        type: 'contest_announcement',
        matchId: result.matchId,
        contestTitle: result.contestTitle || "Contest",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        expiresAt: admin.firestore.Timestamp.fromDate(new Date(Date.now() + 24 * 60 * 60 * 1000)),
      });
    } catch (e) { 
      console.error("Story creation failed:", e); 
    }

    return { matchId: result.matchId };
  } catch (error: any) {
    console.error("[startContestMatch] Error:", error);
    if (error instanceof HttpsError) throw error;
    throw new HttpsError("internal", error.message || "Failed to start match");
  }
});

/**
 * Join an existing contest match (User B)
 */
export const joinContestMatch = onCall(async (request) => {
  const { auth } = request;
  if (!auth) throw new HttpsError("unauthenticated", "User must be logged in.");

  const { matchId, mediaUrl, mediaType, caption, deviceId } = request.data;
  const uid = auth.uid;

  console.log(`[joinContestMatch] User ${uid} joining match ${matchId}`);

  try {
    const result = await db.runTransaction(async (transaction) => {
      const matchRef = db.collection("contestMatches").doc(matchId);
      const userRef = db.collection("users").doc(uid);
      
      const matchDoc = await transaction.get(matchRef);
      const userDoc = await transaction.get(userRef);

      if (!matchDoc.exists) throw new HttpsError("not-found", "Match not found.");
      if (!userDoc.exists) throw new HttpsError("not-found", "User document not found.");

      const matchData = matchDoc.data()!;
      if (matchData.status !== "waiting_for_opponent") throw new HttpsError("failed-precondition", "Match unavailable.");
      if (matchData.userA.uid === uid) throw new HttpsError("failed-precondition", "You cannot join your own match.");

      const userData = userDoc.data()!;
      const entryFee = (matchData.entryFee || 0) / 2;

      if ((userData.coins || userData.fishCoins || 0) < entryFee) {
        throw new HttpsError("failed-precondition", "Insufficient coins.");
      }

      // Deduct coins
      const coinField = userData.coins !== undefined ? "coins" : "fishCoins";
      transaction.update(userRef, {
        [coinField]: FieldValue.increment(-entryFee),
        xp: FieldValue.increment(10),
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
          joinedAt: FieldValue.serverTimestamp(),
          deviceId: deviceId || "",
        },
        activatedAt: FieldValue.serverTimestamp(),
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
      await db.collection("stories").add({
        userId: uid,
        username: result.userBName || "Anonymous",
        avatarUrl: result.userBPic || "",
        mediaUrl: mediaUrl,
        mediaType: mediaType || 'photo',
        type: 'contest_match_live',
        matchId: matchId,
        contestTitle: result.matchTitle || "Contest",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        expiresAt: admin.firestore.Timestamp.fromDate(new Date(Date.now() + 24 * 60 * 60 * 1000)),
      });
    } catch (e) { 
      console.error("Story creation failed:", e); 
    }

    await sendPushNotification(
      result.userAId,
      "Match Live! 🚀",
      `${result.userBName} has joined your battle "${result.matchTitle}". Voting is now open!`,
      "match_active",
      { matchId }
    );

    return { status: "active" };
  } catch (error: any) {
    console.error("[joinContestMatch] Error:", error);
    if (error instanceof HttpsError) throw error;
    throw new HttpsError("internal", error.message || "Failed to join match");
  }
});
