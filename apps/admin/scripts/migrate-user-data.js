
const admin = require('firebase-admin');

// IMPORTANT: Replace this with the path to your service account key JSON file.
// This file grants the script administrative access to your Firebase project.
// You can download it from Firebase Console -> Project settings -> Service accounts -> Generate new private key.
// For development, you can set an environment variable:
// export GOOGLE_APPLICATION_CREDENTIALS="/path/to/your/serviceAccountKey.json"
// Or uncomment the line below and replace with the direct path:
// const serviceAccount = require('../../apps/admin/scripts/serviceAccountKey.json'); // Adjust path as needed

// Initialize Firebase Admin SDK if not already initialized
if (!admin.apps.length) {
  try {
    // If GOOGLE_APPLICATION_CREDENTIALS environment variable is set, it will be used automatically.
    // Otherwise, you can explicitly initialize with the service account key.
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      admin.initializeApp();
      console.log('Firebase Admin SDK initialized using GOOGLE_APPLICATION_CREDENTIALS environment variable.');
    } else {
      // Fallback if environment variable is not set, assuming serviceAccountKey.json exists.
      // Ensure the path to serviceAccountKey.json is correct for your setup.
      const serviceAccount = require('./serviceAccountKey.json'); 
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
      console.log('Firebase Admin SDK initialized using serviceAccountKey.json directly.');
    }
  } catch (error) {
    console.error('Error initializing Firebase Admin SDK:', error);
    console.error('Please ensure your service account key path is correct or GOOGLE_APPLICATION_CREDENTIALS is set.');
    process.exit(1);
  }
}

const db = admin.firestore();

async function migrateUserData() {
  console.log('Starting data migration for existing users...');

  try {
    const usersRef = db.collection('users');
    const snapshot = await usersRef.get();

    if (snapshot.empty) {
      console.log('No existing users found to migrate.');
      return;
    }

    const batch = db.batch();
    let updatedCount = 0;

    snapshot.forEach(doc => {
      const userData = doc.data();
      const userRef = doc.ref;

      let needsUpdate = false;
      const updateData = {};

      // Check and set default for fishCoins
      if (typeof userData.fishCoins === 'undefined') {
        updateData.fishCoins = 0;
        needsUpdate = true;
      }

      // Check and set default for level (XP Level)
      if (typeof userData.level === 'undefined') {
        updateData.level = 0;
        needsUpdate = true;
      }

      // Check and set default for stats object and its nested fields
      if (typeof userData.stats === 'undefined') {
        updateData.stats = {
          followersCount: 0,
          followingCount: 0,
          wins: 0,
          totalVotesReceived: 0,
          contestsJoined: 0,
        };
        needsUpdate = true;
      } else {
        // If stats object exists, check its nested fields
        if (typeof userData.stats.followersCount === 'undefined') {
          updateData['stats.followersCount'] = 0;
          needsUpdate = true;
        }
        if (typeof userData.stats.followingCount === 'undefined') {
          updateData['stats.followingCount'] = 0;
          needsUpdate = true;
        }
        if (typeof userData.stats.wins === 'undefined') {
          updateData['stats.wins'] = 0;
          needsUpdate = true;
        }
        if (typeof userData.stats.totalVotesReceived === 'undefined') {
          updateData['stats.totalVotesReceived'] = 0;
          needsUpdate = true;
        }
        if (typeof userData.stats.contestsJoined === 'undefined') {
          updateData['stats.contestsJoined'] = 0;
          needsUpdate = true;
        }
      }

      if (needsUpdate) {
        batch.update(userRef, updateData);
        updatedCount++;
      }
    });

    if (updatedCount > 0) {
      await batch.commit();
      console.log(`Successfully migrated data for ${updatedCount} existing users.`);
    } else {
      console.log('No updates needed for existing users.');
    }

  } catch (error) {
    console.error('Error during data migration:', error);
    process.exit(1);
  }

  console.log('Data migration complete.');
}

migrateUserData();
