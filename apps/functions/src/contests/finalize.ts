import { onSchedule } from "firebase-functions/v2/scheduler";
import * as admin from "firebase-admin";
import { sendPushNotification } from "../notifications/sender";
import { awardXp } from "../utils/gamification";
import { MemoryOption } from "firebase-functions/v2/options"; // Import MemoryOption

const SCHEDULED_CONFIG = {
  region: "us-central1", // Cheaper region
  cpu: 0.25, // Minimum CPU
  memory: "256MiB" as MemoryOption, // Cast to MemoryOption
};

/**
 * Scheduled function to check for ended contests and distribute rewards.
 * Ran every 1 hour to save costs (was 1 min or implied frequent).
 */
export const finalizeContests = onSchedule({
    ...SCHEDULED_CONFIG,
    schedule: "every 1 hours"
}, async (event) => {
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
      let loserId2 = null; // In case of tie/no win
      const votesA = battleData.userA.votes;
      const votesB = battleData.userB.votes;

      if (votesA > votesB && votesA >= (contestData.minimumVotes || 0)) {
        winnerId = battleData.userA.userId;
        loserId = battleData.userB.userId;
      } else if (votesB > votesA && votesB >= (contestData.minimumVotes || 0)) {
        winnerId = battleData.userB.userId;
        loserId = battleData.userA.userId;
      } else {
        // Tie or min votes not met
        loserId = battleData.userA.userId;
        loserId2 = battleData.userB.userId;
      }

      const batch = db.batch();
      batch.update(db.collection("battles").doc(battleDoc.id), { 
        status: "ended", 
        winnerId: winnerId || "none" 
      });

      if (winnerId) {
        const totalPrize = (contestData.winningCoins || 0) + (contestData.fishCoinsReward || 0);
        
        // Update Winner Coins & Stats
        batch.update(db.collection("users").doc(winnerId), {
          fishCoins: admin.firestore.FieldValue.increment(totalPrize),
          "stats.wins": admin.firestore.FieldValue.increment(1)
        });

        // Record Transaction
        const transRef = db.collection("coin_transactions").doc();
        batch.set(transRef, {
          userId: winnerId, amount: totalPrize, type: "win_reward", contestId, battleId: battleDoc.id, description: `Winner reward for ${contestData.name}`, createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        await batch.commit();

        // Gamification: Award XP
        await awardXp(winnerId, 500, "battle_win");
        if (loserId) await awardXp(loserId, 100, "battle_loss");

        // NOTIFICATIONS
        await sendPushNotification(winnerId, "CONGRATULATIONS! 🎉", `You won the ${contestData.name} contest and earned ${totalPrize} coins!`, "contest_won");
        if (loserId) {
          await sendPushNotification(loserId, "Battle Ended 🏁", `The results for ${contestData.name} are in. Better luck next time! (+100 XP)`, "contest_lost");
        }
      } else {
        await batch.commit();
        
        // Award Participation XP even for ties
        if (loserId) await awardXp(loserId, 50, "battle_tie");
        if (loserId2) await awardXp(loserId2, 50, "battle_tie");

        if (loserId) await sendPushNotification(loserId, "Contest Ended", `No winner in ${contestData.name}. (+50 XP)`, "contest_ended");
        if (loserId2) await sendPushNotification(loserId2, "Contest Ended", `No winner in ${contestData.name}. (+50 XP)`, "contest_ended");
      }
    }
    console.log(`Finalized ${expiredBattlesSnap.size} battles.`);
  } catch (error) {
    console.error("Error finalizing:", error);
  }
});
