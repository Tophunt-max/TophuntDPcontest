import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";
import { db } from "../utils/firebase";
import { sendPushNotification } from "../notifications/sender";
import { awardXp } from "../utils/gamification";

/**
 * Join a contest and handle the VS pairing logic.
 * Coin deduction happens ONLY when a pair is formed.
 */
export const joinContest = onCall({ cors: true }, async (request) => {
  // 1. Authenticate User
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "User must be logged in.");
  }

  const { contestId, mediaUrl, caption, username, displayName } = request.data;
  const userId = request.auth.uid;

  if (!contestId || !mediaUrl) {
    throw new HttpsError("invalid-argument", "Missing contestId or mediaUrl.");
  }

  try {
    // PRE-TRANSACTION: Check if user already joined (Query)
    const existingEntryQuery = db.collection("entries")
      .where("contestId", "==", contestId)
      .where("userId", "==", userId)
      .limit(1);
    
    const existingEntrySnap = await existingEntryQuery.get();
    if (!existingEntrySnap.empty) {
      throw new HttpsError("already-exists", "You have already joined this contest.");
    }

    // PRE-TRANSACTION: Find a potential opponent (Query)
    const waitingQuery = db.collection("entries")
      .where("contestId", "==", contestId)
      .where("status", "==", "waiting")
      .orderBy("createdAt", "asc")
      .limit(1);

    const waitingSnap = await waitingQuery.get();
    let potentialOpponentRef = null;
    if (!waitingSnap.empty) {
      potentialOpponentRef = waitingSnap.docs[0].ref;
    }

    const result = await db.runTransaction(async (transaction) => {
      // 2. Get Contest Details
      const contestRef = db.collection("contests").doc(contestId);
      const contestDoc = await transaction.get(contestRef);

      if (!contestDoc.exists) {
        throw new HttpsError("not-found", "Contest not found.");
      }

      const contestData = contestDoc.data()!;
      if (contestData.status !== "live") {
        throw new HttpsError("failed-precondition", "Contest is not live.");
      }

      // 3. Re-verify opponent inside transaction
      let opponentEntry = null;
      if (potentialOpponentRef) {
        const freshOpponentDoc = await transaction.get(potentialOpponentRef);
        if (freshOpponentDoc.exists) {
          const data = freshOpponentDoc.data();
          // Ensure still waiting and not self (though self check covered by existingEntry check)
          if (data && data.status === "waiting" && data.userId !== userId) {
            opponentEntry = data;
          }
        }
      }

      if (!opponentEntry) {
        // NO OPPONENT (or opponent taken/invalid): Create a waiting entry
        const entryId = db.collection("entries").doc().id;
        const newEntry = {
          id: entryId,
          contestId,
          userId,
          username,
          userDisplayName: displayName,
          mediaUrl,
          caption: caption || "",
          status: "waiting",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        transaction.set(db.collection("entries").doc(entryId), newEntry);
        return { status: "waiting", message: "Joined! Waiting for an opponent." };
      } else {
        // OPPONENT FOUND: Create Battle + Deduct Coins
        const opponentId = opponentEntry.userId;

        const userRef = db.collection("users").doc(userId);
        const opponentRef = db.collection("users").doc(opponentId);
        
        const [userDoc, opponentDoc] = await Promise.all([
          transaction.get(userRef),
          transaction.get(opponentRef)
        ]);

        const entryFeePerUser = contestData.entryFishCoins / 2;

        if ((userDoc.data()?.fishCoins || 0) < entryFeePerUser) {
          throw new HttpsError("failed-precondition", "Insufficient Fish Coins.");
        }
        
        if ((opponentDoc.data()?.fishCoins || 0) < entryFeePerUser) {
           // Edge case: Opponent went broke while waiting.
           const entryId = db.collection("entries").doc().id;
           const newEntry = {
              id: entryId,
              contestId,
              userId,
              username,
              userDisplayName: displayName,
              mediaUrl,
              caption: caption || "",
              status: "waiting",
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
            };
            transaction.set(db.collection("entries").doc(entryId), newEntry);
            return { status: "waiting", message: "Joined! Waiting for an opponent (Opponent disqualified)." };
        }

        transaction.update(userRef, { 
          fishCoins: admin.firestore.FieldValue.increment(-entryFeePerUser),
          "stats.contestsJoined": admin.firestore.FieldValue.increment(1)
        });
        transaction.update(opponentRef, { 
          fishCoins: admin.firestore.FieldValue.increment(-entryFeePerUser),
          "stats.contestsJoined": admin.firestore.FieldValue.increment(1)
        });

        // Create Battle
        const voteDurationDays = contestData.voteDurationDays || 1;
        const battleEndDate = admin.firestore.Timestamp.fromMillis(Date.now() + (voteDurationDays * 24 * 60 * 60 * 1000));

        const battleId = db.collection("battles").doc().id;
        const newBattle = {
          id: battleId,
          contestId,
          contestName: contestData.name,
          contestType: contestData.type || 'photo',
          userA: {
            userId: opponentId,
            username: opponentEntry.username,
            displayName: opponentEntry.userDisplayName,
            mediaUrl: opponentEntry.mediaUrl,
            votes: 0,
          },
          userB: {
            userId: userId,
            username: username,
            displayName: displayName,
            mediaUrl: mediaUrl,
            votes: 0,
          },
          totalVotes: 0,
          status: "active",
          endDate: battleEndDate,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        transaction.set(db.collection("battles").doc(battleId), newBattle);

        // Update Entries to 'paired'
        transaction.update(db.collection("entries").doc(opponentEntry.id), { status: "paired", battleId });

        const currentEntryId = db.collection("entries").doc().id;
        transaction.set(db.collection("entries").doc(currentEntryId), {
          id: currentEntryId,
          contestId,
          userId,
          username,
          userDisplayName: displayName,
          mediaUrl,
          caption: caption || "",
          status: "paired",
          battleId,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        // Transaction Records
        const transARef = db.collection("coin_transactions").doc();
        const transBRef = db.collection("coin_transactions").doc();

        transaction.set(transARef, {
          userId: opponentId, amount: -entryFeePerUser, type: "entry_fee", contestId, battleId, description: `Entry fee for contest ${contestData.name}`, createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        transaction.set(transBRef, {
          userId, amount: -entryFeePerUser, type: "entry_fee", contestId, battleId, description: `Entry fee for contest ${contestData.name}`, createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        return { 
            status: "paired", 
            battleId, 
            message: "Battle started!",
            opponentId,
            contestName: contestData.name
        };
      }
    });

    // 9. Send Push Notifications & Award XP
    if (result.status === "paired") {
        await Promise.all([
            sendPushNotification(result.opponentId, "Opponent Found! ⚔️", `Your battle in ${result.contestName} has started!`, "battle_started"),
            sendPushNotification(userId, "Battle Live! 🚀", `You are now competing in ${result.contestName}!`, "battle_started")
        ]);
    }

    // Award XP for joining (50 XP)
    awardXp(userId, 50, "contest_join").catch(err => console.error("XP Award Failed:", err));

    return result;
  } catch (error: any) {
    console.error("Error in joinContest:", error);
    if (error.code && error.details) {
        throw error;
    }
    throw new HttpsError("internal", error.message || "Something went wrong.");
  }
});
