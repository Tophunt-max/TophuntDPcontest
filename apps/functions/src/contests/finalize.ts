import { onSchedule } from "firebase-functions/v2/scheduler";
import * as admin from "firebase-admin";
import { createNotification } from "../notifications/utils";
import { MemoryOption } from "firebase-functions/v2/options";

const SCHEDULED_CONFIG = {
  region: "us-central1",
  cpu: 0.25,
  memory: "256MiB" as MemoryOption,
};

/**
 * Scheduled function to check for ended contest matches and distribute rewards.
 */
export const finalizeContests = onSchedule({
    ...SCHEDULED_CONFIG,
    schedule: "every 30 minutes" // Checked more frequently
}, async (event) => {
  const db = admin.firestore();
  const now = admin.firestore.Timestamp.now();

  try {
    // 1. REFUND STALLED MATCHES (Waiting for opponent for too long)
    const stalledMatchesSnap = await db.collection("contestMatches")
        .where("status", "==", "waiting_for_opponent")
        .where("expiresAt", "<=", now)
        .limit(20)
        .get();
    
    for (const stalledDoc of stalledMatchesSnap.docs) {
        const data = stalledDoc.data();
        // Use a precise refund amount based on what was likely charged (ceiling of half)
        const totalEntryFee = Number(data.entryFee || 0);
        const refundAmount = Math.ceil(totalEntryFee / 2); 
        const uid = data.userA.uid;

        const batch = db.batch();
        batch.update(db.collection("users").doc(uid), {
            Dpcoin: admin.firestore.FieldValue.increment(refundAmount)
        });
        batch.update(db.collection("contestMatches").doc(stalledDoc.id), { status: "cancelled" });
        
        // Record refund transaction
        const transRef = db.collection("coinTransactions").doc();
        batch.set(transRef, {
            uid, amount: refundAmount, type: "contest_refund", matchId: stalledDoc.id,
            description: "Refund: No opponent found.", timestamp: admin.firestore.FieldValue.serverTimestamp()
        });

        await batch.commit();
        await createNotification(uid, {
            title: "Match Cancelled",
            body: "No opponent found. Your Dpcoins have been refunded.",
            type: "contest",
            targetId: stalledDoc.id
        });
    }

    // 2. FINALIZE ACTIVE MATCHES
    const expiredMatchesSnap = await db.collection("contestMatches")
      .where("status", "==", "active")
      .where("expiresAt", "<=", now)
      .limit(30)
      .get();

    for (const matchDoc of expiredMatchesSnap.docs) {
      const matchData = matchDoc.data();
      const contestId = matchData.contestId;

      const contestDoc = await db.collection("contests").doc(contestId).get();
      if (!contestDoc.exists) {
          // If contest template deleted, just end the match to stop the loop
          await db.collection("contestMatches").doc(matchDoc.id).update({ status: "ended", winnerId: "none" });
          continue;
      }
      
      const contestData = contestDoc.data()!;
      let winnerId = null;
      let loserId = null;
      
      const votesA = matchData.userA.votes || 0;
      const votesB = matchData.userB.votes || 0;
      const minVotes = contestData.minVotes || 0;

      // Determine Winner
      if (votesA > votesB && votesA >= minVotes) {
        winnerId = matchData.userA.uid;
        loserId = matchData.userB.uid;
      } else if (votesB > votesA && votesB >= minVotes) {
        winnerId = matchData.userB.uid;
        loserId = matchData.userA.uid;
      }

      const batch = db.batch();
      const matchRef = db.collection("contestMatches").doc(matchDoc.id);

      if (winnerId) {
        // --- CASE 1: WE HAVE A WINNER ---
        const totalPrize = Number(contestData.rewardCoins || contestData.winningCoins || 0);
        
        batch.update(matchRef, { status: "ended", winnerId: winnerId });
        
        // Update Winner
        batch.update(db.collection("users").doc(winnerId), {
          Dpcoin: admin.firestore.FieldValue.increment(totalPrize),
          "stats.wins": admin.firestore.FieldValue.increment(1),
          xp: admin.firestore.FieldValue.increment(500) // XP inside batch
        });

        // Update Loser (XP only)
        if (loserId) {
            batch.update(db.collection("users").doc(loserId), {
                xp: admin.firestore.FieldValue.increment(100)
            });
        }

        const transRef = db.collection("coinTransactions").doc();
        batch.set(transRef, {
          uid: winnerId, amount: totalPrize, type: "win_reward", 
          contestId, matchId: matchDoc.id, 
          description: `Winner reward for ${contestData.title || 'Contest'}`, 
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
        });

        await batch.commit();

        // Notifications
        await createNotification(winnerId, {
            title: "CONGRATULATIONS! 🎉",
            body: `You won the battle and earned ${totalPrize} Dpcoins!`,
            type: "contest", targetId: matchDoc.id,
            image: matchData.userA.uid === winnerId ? matchData.userA.mediaUrl : matchData.userB.mediaUrl
        });
        
        if (loserId) {
            await createNotification(loserId, {
                title: "Battle Ended 🏁",
                body: `The results are in. Better luck next time!`,
                type: "contest", targetId: matchDoc.id,
                image: matchData.userA.uid === loserId ? matchData.userA.mediaUrl : matchData.userB.mediaUrl
            });
        }
      } else {
        // --- CASE 2: DRAW OR MIN VOTES NOT MET ---
        // Precise refund logic
        const totalEntryFee = Number(matchData.entryFee || 0);
        const refundAmount = Math.ceil(totalEntryFee / 2); 

        batch.update(matchRef, { status: "ended", winnerId: "draw" });
        
        if (refundAmount > 0) {
            batch.update(db.collection("users").doc(matchData.userA.uid), { 
                Dpcoin: admin.firestore.FieldValue.increment(refundAmount) 
            });
            batch.update(db.collection("users").doc(matchData.userB.uid), { 
                Dpcoin: admin.firestore.FieldValue.increment(refundAmount) 
            });
        }
        await batch.commit();
        
        const drawMsg = votesA === votesB ? "It was a draw!" : "Minimum votes not met.";
        
        await createNotification(matchData.userA.uid, {
            title: "Contest Ended", body: `${drawMsg} Entry fees refunded.`,
            type: "contest", targetId: matchDoc.id
        });
        
        await createNotification(matchData.userB.uid, {
            title: "Contest Ended", body: `${drawMsg} Entry fees refunded.`,
            type: "contest", targetId: matchDoc.id
        });
      }
    }
  } catch (error) {
    console.error("Error finalizing contest matches:", error);
  }
});
