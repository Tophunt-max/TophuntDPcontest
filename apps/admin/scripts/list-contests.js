
const admin = require('firebase-admin');
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');

const envPath = path.join(process.cwd(), '.env.local');
dotenv.config({ path: envPath });

const projectId = process.env.FIREBASE_PROJECT_ID;
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
const privateKey = process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId,
      clientEmail,
      privateKey,
    }),
  });
}

const db = admin.firestore();

async function listContests() {
  try {
    console.log('Fetching from default database...');
    const snapshot = await db.collection('contests').get();
    if (snapshot.empty) {
      console.log('No contests found in "contests" collection.');
    } else {
      console.log(`Found ${snapshot.size} contests:`);
      snapshot.forEach(doc => {
        console.log(`- ${doc.id}:`, doc.data());
      });
    }
  } catch (error) {
    console.error('Error:', error);
  } finally {
    process.exit();
  }
}

listContests();
