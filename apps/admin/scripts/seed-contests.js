
const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');
const dotenv = require('dotenv');
const path = require('path');

// Load environment variables
const envPath = path.join(__dirname, '..', '.env.local');
dotenv.config({ path: envPath });

const projectId = process.env.FIREBASE_PROJECT_ID;
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

if (!projectId || !clientEmail || !privateKey) {
    console.error("Missing environment variables in .env.local");
    process.exit(1);
}

try {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId,
      clientEmail,
      privateKey,
    }),
  });
} catch (error) {
  console.error("Firebase Admin SDK initialization error:", error);
}

const db = getFirestore(); // DEFAULT DATABASE

async function seedContest() {
  console.log("Seeding a sample photo contest into DEFAULT database...");
  const contestRef = db.collection('contests').doc();
  await contestRef.set({
    title: "Best Instagram DP",
    type: "photo",
    description: "Show off your best profile picture!",
    rules: "1. Must be a portrait. 2. High quality.",
    totalEntryFee: 100, // 50 coins per user
    rewardCoins: 150,
    rewardXP: 100,
    minVotes: 5,
    durationHours: 24,
    autoCancelHours: 24,
    status: "live",
    bannerUrl: "https://images.unsplash.com/photo-1511367461989-f85a21fda167?w=800",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  console.log("Successfully seeded contest with ID:", contestRef.id);
}

seedContest().then(() => process.exit());
