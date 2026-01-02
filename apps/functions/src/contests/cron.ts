import { onSchedule } from "firebase-functions/v2/scheduler";
import { db, admin } from "../utils/firebase";
import { FieldValue } from "firebase-admin/firestore";
import { sendPushNotification } from "../notifications/sender";

/**
 * AUTOMATED MATCH RESOLVER
 * Runs every 10 minutes to check for finished matches.
 */
export const resolveContests = onSchedule("every 10 minutes", async (event) => {
  const now = admin.firestore.Timestamp.now();

  // 1. Resolve Active Matches that have expired
  const activeMatches = await db.collection("contestMatches")
    .where("status", "==", "active")
    .where("expiresAt", "<=", now)
    .limit(50)
    .get();

  for (const doc of activeMatches.docs) {
    await resolveMatch(doc);
  }

  // 2. Refund User A if no opponent joined (Expired waiting matches)
  const waitingMatches = await db.collection("contestMatches")
    .where("status", "==", "waiting_for_opponent")
    .where("expiresAt", "<=", now)
    .limit(50)
    .get();

  for (const doc of waitingMatches.docs) {
    await refundMatch(doc);
  }
});

/**
 * MONTHLY HALL OF FAME
 * Runs on the 1st of every month to reward Top 3 players.
 */
export const monthlyHallOfFame = onSchedule("0 0 1 * *", async (event) => {
  const usersRef = db.collection("users");
  
  // Get Top 3 users by monthly wins
  const snapshot = await usersRef
    .orderBy("stats.monthlyWins", "desc")
    .limit(3)
    .get();

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
        coins: FieldValue.increment(reward),
        xp: FieldValue.increment(500),
        badges: FieldValue.arrayUnion(badgeName),
        "stats.monthlyWins": 0 // Reset for the new month
      });

      // Record Transaction
      const transRef = db.collection("coinTransactions").doc();
      transaction.set(transRef, {
        uid: userId,
        amount: reward,
        type: "monthly_hall_of_fame_reward",
        rank: i + 1,
        timestamp: FieldValue.serverTimestamp()
      });
    });

    // Send Winner Notification
    await sendPushNotification(
      userId,
      "Monthly Hall of Fame! 🏆",
      `Congratulations! You ranked #${i + 1} this month. You've earned ${reward} coins and the ${badgeName}!`,
      "hall_of_fame"
    );
  }
});

/**
 * HELPER: Resolve a specific active match
 */
async function resolveMatch(doc: admin.firestore.DocumentSnapshot) {
  const data = doc.data()!;
  const { userA, userB, entryFee, title } = data;
  const matchId = doc.id;

  let winnerUid = "";
  let loserUid = "";
  let rewardAmount = entryFee; // Winner takes all

  if (userA.votes > userB.votes) {
    winnerUid = userA.uid;
    loserUid = userB.uid;
  } else if (userB.votes > userA.votes) {
    winnerUid = userB.uid;
    loserUid = userA.uid;
  } else {
    // It's a tie
    await refundTieMatch(doc);
    return;
  }

  await db.runTransaction(async (transaction) => {
    // 1. Mark match completed
    transaction.update(doc.ref, {
      status: "completed",
      winnerUid,
      completedAt: FieldValue.serverTimestamp()
    });

    // 2. Award winner
    transaction.update(db.collection("users").doc(winnerUid), {
      coins: FieldValue.increment(rewardAmount),
      xp: FieldValue.increment(100),
      "stats.wins": FieldValue.increment(1),
      "stats.monthlyWins": FieldValue.increment(1)
    });

    // 3. Loser still gets minor XP for participation
    transaction.update(db.collection("users").doc(loserUid), {
      xp: FieldValue.increment(20)
    });

    // 4. Record Transaction
    const transRef = db.collection("coinTransactions").doc();
    transaction.set(transRef, {
      uid: winnerUid,
      amount: rewardAmount,
      type: "contest_win_reward",
      matchId,
      timestamp: FieldValue.serverTimestamp()
    });
  });

  // PUSH NOTIFICATIONS
  await sendPushNotification(
    winnerUid,
    "You Won! 🏆",
    `Victory! You won the battle "${title}" and earned ${rewardAmount} coins!`,
    "contest_win",
    { matchId }
  );

  await sendPushNotification(
    loserUid,
    "Battle Ended",
    `The battle "${title}" has concluded. You played well!`,
    "contest_loss",
    { matchId }
  );
}

/**
 * HELPER: Refund User A if match never started
 */
async function refundMatch(doc: admin.firestore.DocumentSnapshot) {
  const data = doc.data()!;
  const refundAmount = data.entryFee / 2;
  const userId = data.userA.uid;

  await db.runTransaction(async (transaction) => {
    transaction.update(doc.ref, {
      status: "cancelled",
      cancelledReason: "No opponent joined",
      cancelledAt: FieldValue.serverTimestamp()
    });

    transaction.update(db.collection("users").doc(userId), {
      coins: FieldValue.increment(refundAmount)
    });

    const transRef = db.collection("coinTransactions").doc();
    transaction.set(transRef, {
      uid: userId,
      amount: refundAmount,
      type: "contest_refund",
      matchId: doc.id,
      timestamp: FieldValue.serverTimestamp()
    });
  });

  await sendPushNotification(
    userId,
    "Contest Refunded",
    `No opponent joined your "${data.title}" contest. ${refundAmount} coins have been returned.`,
    "contest_refund"
  );
}

/**
 * HELPER: Handle Ties
 */
async function refundTieMatch(doc: admin.firestore.DocumentSnapshot) {
  const data = doc.data()!;
  const refundAmount = data.entryFee / 2;
  
  await db.runTransaction(async (transaction) => {
    transaction.update(doc.ref, { 
      status: "completed", 
      result: "tie", 
      completedAt: FieldValue.serverTimestamp() 
    });

    transaction.update(db.collection("users").doc(data.userA.uid), { coins: FieldValue.increment(refundAmount) });
    transaction.update(db.collection("users").doc(data.userB.uid), { coins: FieldValue.increment(refundAmount) });
  });

  await sendPushNotification(data.userA.uid, "It's a Tie!", "The match ended in a tie. Entry fees refunded.", "contest_tie");
  await sendPushNotification(data.userB.uid, "It's a Tie!", "The match ended in a tie. Entry fees refunded.", "contest_tie");
}
