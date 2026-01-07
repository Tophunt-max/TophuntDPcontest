import { onSchedule } from "firebase-functions/v2/scheduler";
import * as admin from "firebase-admin";
import { sendPushNotification } from "../notifications/sender";
import { awardXp } from "../utils/gamification";
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
    schedule: "every 1 hours"
}, async (event) => {
  const db = admin.firestore();
  const now = admin.firestore.Timestamp.now();

  try {
    // We check 'contestMatches' which are active and expired
    const expiredMatchesSnap = await db.collection("contestMatches")
      .where("status", "==", "active")
      .where("expiresAt", "<=", now)
      .limit(50)
      .get();

    if (expiredMatchesSnap.empty) {
        // Also check for 'waiting' matches that never found an opponent
        const stalledMatchesSnap = await db.collection("contestMatches")
            .where("status", "==", "waiting_for_opponent")
            .where("expiresAt", "<=", now)
            .limit(20)
            .get();
        
        for (const stalledDoc of stalledMatchesSnap.docs) {
            const data = stalledDoc.data();
            const refundAmount = Number(data.entryFee || 0) / 2;
            const uid = data.userA.uid;

            // Refund Dpcoin to User A
            await db.collection("users").doc(uid).update({
                Dpcoin: admin.firestore.FieldValue.increment(refundAmount)
            });
            await db.collection("contestMatches").doc(stalledDoc.id).update({ status: "cancelled" });
            await sendPushNotification(uid, "Match Cancelled", "No opponent found. Your Dpcoins have been refunded.", "match_cancelled");
        }
        return;
    }

    for (const matchDoc of expiredMatchesSnap.docs) {
      const matchData = matchDoc.data();
      const contestId = matchData.contestId;

      // Get contest template for reward info
      const contestDoc = await db.collection("contests").doc(contestId).get();
      if (!contestDoc.exists) continue;
      const contestData = contestDoc.data()!;

      let winnerId = null;
      let loserId = null;
      
      const votesA = matchData.userA.votes || 0;
      const votesB = matchData.userB.votes || 0;
      const minVotes = contestData.minVotes || 0;

      if (votesA > votesB && votesA >= minVotes) {
        winnerId = matchData.userA.uid;
        loserId = matchData.userB.uid;
      } else if (votesB > votesA && votesB >= minVotes) {
        winnerId = matchData.userB.uid;
        loserId = matchData.userA.uid;
      }

      const batch = db.batch();
      batch.update(db.collection("contestMatches").doc(matchDoc.id), { 
        status: "ended", 
        winnerId: winnerId || "none" 
      });

      if (winnerId) {
        // Reward is Dpcoin
        const totalPrize = Number(contestData.rewardCoins || contestData.winningCoins || 0);
        
        const winnerRef = db.collection("users").doc(winnerId);
        
        batch.update(winnerRef, {
          Dpcoin: admin.firestore.FieldValue.increment(totalPrize),
          "stats.wins": admin.firestore.FieldValue.increment(1)
        });

        // Record Transaction
        const transRef = db.collection("coinTransactions").doc();
        batch.set(transRef, {
          uid: winnerId, 
          amount: totalPrize, 
          type: "win_reward", 
          contestId, 
          matchId: matchDoc.id, 
          description: `Winner reward for ${contestData.title || 'Contest'}`, 
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
        });

        await batch.commit();

        // Gamification
        await awardXp(winnerId, 500, "battle_win");
        if (loserId) await awardXp(loserId, 100, "battle_loss");

        // Notifications
        await sendPushNotification(winnerId, "CONGRATULATIONS! 🎉", `You won the battle and earned ${totalPrize} Dpcoins!`, "contest_won");
        if (loserId) {
          await sendPushNotification(loserId, "Battle Ended 🏁", `The results are in. Better luck next time!`, "contest_lost");
        }
      } else {
        // Tie or Min votes not met - Refund partial entry fee
        const entryFeePerUser = Number(matchData.entryFee || 0) / 2;
        if (entryFeePerUser > 0) {
            batch.update(db.collection("users").doc(matchData.userA.uid), { Dpcoin: admin.firestore.FieldValue.increment(entryFeePerUser) });
            batch.update(db.collection("users").doc(matchData.userB.uid), { Dpcoin: admin.firestore.FieldValue.increment(entryFeePerUser) });
        }
        await batch.commit();
        
        await sendPushNotification(matchData.userA.uid, "Contest Ended", "No winner declared. Entry fees refunded.", "contest_ended");
        await sendPushNotification(matchData.userB.uid, "Contest Ended", "No winner declared. Entry fees refunded.", "contest_ended");
      }
    }
  } catch (error) {
    console.error("Error finalizing contest matches:", error);
  }
});
