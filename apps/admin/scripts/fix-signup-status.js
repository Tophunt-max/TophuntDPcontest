const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

async function fixSignupStatus() {
  console.log('Starting to fix signupCompleted status for all users...');
  
  const usersRef = db.collection('users');
  const snapshot = await usersRef.get();
  
  if (snapshot.empty) {
    console.log('No users found.');
    return;
  }

  let updatedCount = 0;
  let skippedCount = 0;

  const batchSize = 500;
  let batch = db.batch();
  let count = 0;

  for (const doc of snapshot.docs) {
    const data = doc.data();
    
    // Logic: If user has a username but signupCompleted is not true, fix it
    if (data.username && data.signupCompleted !== true) {
      batch.update(doc.ref, { signupCompleted: true });
      updatedCount++;
      count++;

      if (count === batchSize) {
        await batch.commit();
        batch = db.batch();
        count = 0;
        console.log(`Committed a batch of ${batchSize} updates...`);
      }
    } else {
      skippedCount++;
    }
  }

  if (count > 0) {
    await batch.commit();
  }

  console.log('--- Migration Finished ---');
  console.log(`Total users checked: ${snapshot.size}`);
  console.log(`Users updated to signupCompleted=true: ${updatedCount}`);
  console.log(`Users already correct: ${skippedCount}`);
}

fixSignupStatus().catch(console.error);
