const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

async function migrateToDpcoin() {
  console.log("Starting Migration: fishCoins/coins -> Dpcoin");
  const usersRef = db.collection('users');
  const snapshot = await usersRef.get();

  if (snapshot.empty) {
    console.log('No users found.');
    return;
  }

  const batchSize = 100;
  let count = 0;

  for (let i = 0; i < snapshot.docs.length; i += batchSize) {
    const batch = db.batch();
    const chunk = snapshot.docs.slice(i, i + batchSize);

    chunk.forEach(doc => {
      const data = doc.data();
      const fishBalance = data.fishCoins || 0;
      const coinBalance = data.coins || 0;
      
      // If Dpcoin already exists, we might want to keep it or add to it.
      // For this migration, we assume we want to consolidate everything into Dpcoin.
      const totalBalance = data.Dpcoin !== undefined ? data.Dpcoin : (fishBalance + coinBalance);

      batch.update(doc.ref, {
        Dpcoin: totalBalance,
        fishCoins: admin.firestore.FieldValue.delete(),
        coins: admin.firestore.FieldValue.delete()
      });
      count++;
    });

    await batch.commit();
    console.log(`Migrated ${count} users...`);
  }

  console.log("Migration finished successfully!");
}

migrateToDpcoin().catch(console.error);
