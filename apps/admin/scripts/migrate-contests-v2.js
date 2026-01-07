const admin = require("firebase-admin");
const serviceAccount = require("./serviceAccountKey.json");

if (admin.apps.length === 0) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

// Helper to generate Join ID
const generateJoinId = () => {
  return "JN-" + Math.random().toString(36).substring(2, 8).toUpperCase();
};

async function migrateData() {
  console.log("🚀 Starting Migration to ContestMatches...");

  // 1. Migrate BATTLES to contestMatches (Active)
  const battlesSnap = await db.collection("battles").get();
  console.log(`Found ${battlesSnap.size} battles to migrate.`);

  for (const battleDoc of battlesSnap.docs) {
    const data = battleDoc.data();
    const matchId = battleDoc.id;

    const joinIdA = generateJoinId();
    const joinIdB = generateJoinId();

    const newMatch = {
      id: matchId,
      contestId: data.contestId || "legacy_contest",
      status: data.status === "active" ? "active" : "ended",
      type: data.contestType || "photo",
      title: data.contestName || "Legacy Battle",
      entryFee: data.entryFee || 0,
      joinIdA: joinIdA,
      joinIdB: joinIdB,
      joinIds: [joinIdA, joinIdB],
      userA: {
        uid: data.userA.userId || data.userA.uid,
        joinId: joinIdA,
        username: data.userA.username || "Anonymous",
        profilePic: data.userA.profilePic || data.userA.mediaUrl || "",
        mediaUrl: data.userA.mediaUrl,
        votes: data.userA.votes || 0,
        joinedAt: data.createdAt || admin.firestore.FieldValue.serverTimestamp(),
      },
      userB: {
        uid: data.userB.userId || data.userB.uid,
        joinId: joinIdB,
        username: data.userB.username || "Anonymous",
        profilePic: data.userB.profilePic || data.userB.mediaUrl || "",
        mediaUrl: data.userB.mediaUrl,
        votes: data.userB.votes || 0,
        joinedAt: data.createdAt || admin.firestore.FieldValue.serverTimestamp(),
      },
      totalVotes: data.totalVotes || 0,
      likeCount: 0,
      commentCount: 0,
      shareCount: 0,
      createdAt: data.createdAt || admin.firestore.FieldValue.serverTimestamp(),
      expiresAt: data.endDate || admin.firestore.FieldValue.serverTimestamp(),
    };

    await db.collection("contestMatches").doc(matchId).set(newMatch);
    console.log(`✅ Migrated Battle: ${matchId}`);
  }

  // 2. Migrate WAITING ENTRIES to contestMatches (Waiting)
  const entriesSnap = await db.collection("entries").where("status", "==", "waiting").get();
  console.log(`Found ${entriesSnap.size} waiting entries to migrate.`);

  for (const entryDoc of entriesSnap.docs) {
    const data = entryDoc.data();
    const matchId = db.collection("contestMatches").doc().id;
    const joinIdA = generateJoinId();

    const newWaitingMatch = {
      id: matchId,
      contestId: data.contestId,
      status: "waiting_for_opponent",
      type: "photo",
      title: "Waiting for Opponent",
      entryFee: 0, // Legacy data might not have this per entry
      joinIdA: joinIdA,
      joinIdB: null,
      joinIds: [joinIdA],
      userA: {
        uid: data.userId,
        joinId: joinIdA,
        username: data.username || "Anonymous",
        profilePic: data.mediaUrl || "",
        mediaUrl: data.mediaUrl,
        votes: 0,
        joinedAt: data.createdAt || admin.firestore.FieldValue.serverTimestamp(),
      },
      userB: null,
      totalVotes: 0,
      likeCount: 0,
      commentCount: 0,
      shareCount: 0,
      createdAt: data.createdAt || admin.firestore.FieldValue.serverTimestamp(),
      expiresAt: admin.firestore.Timestamp.fromDate(new Date(Date.now() + 24 * 60 * 60 * 1000)),
    };

    await db.collection("contestMatches").doc(matchId).set(newWaitingMatch);
    console.log(`✅ Migrated Waiting Entry: ${entryDoc.id} -> Match: ${matchId}`);
  }

  console.log("🎉 Migration Complete!");
  console.log("⚠️ Now you can manually delete 'battles' and 'entries' collections from Firebase Console.");
}

migrateData().catch(console.error);
