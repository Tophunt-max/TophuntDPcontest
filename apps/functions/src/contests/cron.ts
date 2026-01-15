import { onSchedule } from "firebase-functions/v2/scheduler";
import { db, admin } from "../utils/firebase";
import { FieldValue } from "firebase-admin/firestore";
import { createNotification } from "../notifications/utils";

/**
 * CONTEST MAINTENANCE CRON
 * Runs every 15 minutes to handle non-financial tasks like notifications.
 * Financial resolution is now safely handled by finalize.ts only.
 */
export const contestMaintenance = onSchedule("every 15 minutes", async (event) => {
  const now = admin.firestore.Timestamp.now();

  // 1. Send "Ending Soon" Notifications for matches expiring in < 60 minutes
  const oneHourLater = new Date(Date.now() + 60 * 60 * 1000);
  const endingMatches = await db.collection("contestMatches")
      .where("status", "==", "active")
      .where("expiresAt", ">", now)
      .where("expiresAt", "<=", admin.firestore.Timestamp.fromDate(oneHourLater))
      .where("endingSoonNotified", "==", false)
      .limit(50)
      .get();

  for (const doc of endingMatches.docs) {
      await notifyEndingMatch(doc);
  }
});

/**
 * HELPER: Send "Ending Soon" Notification
 */
async function notifyEndingMatch(doc: admin.firestore.DocumentSnapshot) {
    const data = doc.data()!;
    const matchId = doc.id;
    const { userA, userB, title } = data;
    
    const creatorId = userA.uid;
    const opponentId = userB?.uid;

    const message = `⏳ Hurry! The battle "${title || 'Match'}" ends soon. Get more votes to win!`;

    if (creatorId) {
        await createNotification(creatorId, {
            title: "Battle Ending Soon!",
            body: message,
            type: "contest-ending",
            targetId: matchId
        });
    }

    if (opponentId) {
        await createNotification(opponentId, {
            title: "Battle Ending Soon!",
            body: message,
            type: "contest-ending",
            targetId: matchId
        });
    }

    await doc.ref.update({ endingSoonNotified: true });
}

/**
 * MONTHLY HALL OF FAME
 * Rewards the top 3 players of the month.
 */
export const monthlyHallOfFame = onSchedule("0 0 1 * *", async (event) => {
  const usersRef = db.collection("users");
  const snapshot = await usersRef.orderBy("stats.monthlyWins", "desc").limit(3).get();
  if (snapshot.empty) return;

  const rewards = [1000, 500, 250]; 
  const badges = ["Gold Hall of Fame", "Silver Hall of Fame", "Bronze Hall of Fame"];

  for (let i = 0; i < snapshot.docs.length; i++) {
    const userDoc = snapshot.docs[i];
    const userId = userDoc.id;
    const reward = rewards[i];
    const badgeName = badges[i];

    await db.runTransaction(async (transaction) => {
        transaction.update(userDoc.ref, {
            Dpcoin: FieldValue.increment(reward),
            xp: FieldValue.increment(1000), 
            badges: FieldValue.arrayUnion(badgeName),
            "stats.monthlyWins": 0 
        });

        const transRef = db.collection("coinTransactions").doc();
        transaction.set(transRef, {
            uid: userId,
            amount: reward,
            type: "monthly_hall_of_fame_reward",
            rank: i + 1,
            timestamp: FieldValue.serverTimestamp(),
            description: `Monthly Hall of Fame Rank #${i+1} reward`
        });
    });

    await createNotification(userId, {
        title: "Monthly Hall of Fame! 🏆",
        body: `Congratulations! You ranked #${i + 1} this month. You've earned ${reward} Dpcoins and the ${badgeName}!`,
        type: "hall-of-fame",
        targetId: "profile"
    });
  }
});
