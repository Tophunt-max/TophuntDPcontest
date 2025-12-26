import { onSchedule } from "firebase-functions/v2/scheduler";
import * as admin from "firebase-admin";
import { sendPushNotification } from "../notifications/sender";

/**
 * Scheduled function to check for ended contests and distribute rewards.
 */
export const finalizeContests = onSchedule("every 1 hours", async (event) => {
  const db = admin.firestore();
  const now = admin.firestore.Timestamp.now();

  try {
    const expiredBattlesSnap = await db.collection("battles")
      .where("status", "==", "active")
      .where("endDate", "<=", now)
      .limit(50)
      .get();

    if (expiredBattlesSnap.empty) return;

    for (const battleDoc of expiredBattlesSnap.docs) {
      const battleData = battleDoc.data();
      const contestId = battleData.contestId;

      const contestDoc = await db.collection("contests").doc(contestId).get();
      if (!contestDoc.exists) continue;
      const contestData = contestDoc.data()!;

      let winnerId = null;
      let loserId = null;
      const votesA = battleData.userA.votes;
      const votesB = battleData.userB.votes;

      if (votesA > votesB && votesA >= contestData.minimumVotes) {
        winnerId = battleData.userA.userId;
        loserId = battleData.userB.userId;
      } else if (votesB > votesA && votesB >= contestData.minimumVotes) {
        winnerId = battleData.userB.userId;
        loserId = battleData.userA.userId;
      } else {
        // Tie or min votes not met
        loserId = battleData.userA.userId; // Both lose
        const loserB = battleData.userB.userId;
        await sendPushNotification(loserId, "Contest Ended", `No winner in ${contestData.name} (Tied or Min votes not met).`, "contest_ended");
        await sendPushNotification(loserB, "Contest Ended", `No winner in ${contestData.name} (Tied or Min votes not met).`, "contest_ended");
      }

      const batch = db.batch();
      batch.update(db.collection("battles").doc(battleDoc.id), { 
        status: "ended", 
        winnerId: winnerId || "none" 
      });

      if (winnerId) {
        const totalPrize = (contestData.winningCoins || 0) + (contestData.fishCoinsReward || 0);
        batch.update(db.collection("users").doc(winnerId), {
          fishCoins: admin.firestore.FieldValue.increment(totalPrize),
          "stats.wins": admin.firestore.FieldValue.increment(1)
        });

        const transRef = db.collection("coin_transactions").doc();
        batch.set(transRef, {
          userId: winnerId, amount: totalPrize, type: "win_reward", contestId, battleId: battleDoc.id, description: `Winner reward for ${contestData.name}`, createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        await batch.commit();

        // NOTIFY WINNER & LOSER
        await sendPushNotification(winnerId, "CONGRATULATIONS! 🎉", `You won the ${contestData.name} contest and earned ${totalPrize} coins!`, "contest_won");
        if (loserId) {
          await sendPushNotification(loserId, "Battle Ended 🏁", `The results for ${contestData.name} are in. Better luck next time!`, "contest_lost");
        }
      } else {
        await batch.commit();
      }
    }
    console.log(`Finalized ${expiredBattlesSnap.size} battles.`);
  } catch (error) {
    console.error("Error finalizing:", error);
  }
});
