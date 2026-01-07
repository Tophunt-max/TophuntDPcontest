const admin = require("firebase-admin");
const serviceAccount = require("./serviceAccountKey.json");

if (admin.apps.length === 0) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

async function seedEngagement() {
  console.log("🛠️ Seeding Fake Engagement for ContestMatches...");

  const matchesSnap = await db.collection("contestMatches").limit(5).get();
  
  if (matchesSnap.empty) {
    console.log("❌ No matches found to seed. Run migration or create a match first.");
    return;
  }

  for (const matchDoc of matchesSnap.docs) {
    const matchId = matchDoc.id;
    const matchRef = db.collection("contestMatches").doc(matchId);

    // Update Top-level counts
    await matchRef.update({
      likeCount: Math.floor(Math.random() * 50) + 10,
      commentCount: Math.floor(Math.random() * 20) + 5,
      shareCount: Math.floor(Math.random() * 10) + 2,
      totalVotes: Math.floor(Math.random() * 100) + 20,
      "userA.votes": Math.floor(Math.random() * 50) + 10,
      "userB.votes": Math.floor(Math.random() * 50) + 10,
    });

    // Add some fake comments to the sub-collection
    const fakeComments = [
      "Wow! Amazing entry JN-A!",
      "JN-B is killing it! 🔥",
      "Both are so good, hard to choose.",
      "Voted! Good luck everyone.",
      "This contest is fire! ⚔️"
    ];

    for (const text of fakeComments) {
      await matchRef.collection("comments").add({
        userId: "fake_user_" + Math.floor(Math.random() * 1000),
        text: text,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    console.log(`✅ Seeded Match: ${matchId}`);
  }

  console.log("🎉 Seeding Complete! Check your app now.");
}

seedEngagement().catch(console.error);
