
const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const email = 'tophuntinfo@gmail.com';

async function setAdmin() {
  try {
    const userRecord = await admin.auth().getUserByEmail(email);
    await admin.auth().setCustomUserClaims(userRecord.uid, { role: 'admin' });
    console.log(`Successfully set admin role for user: ${email} (uid: ${userRecord.uid})`);
    
    // Verify
    const user = await admin.auth().getUser(userRecord.uid);
    console.log('Current custom claims:', user.customClaims);
    
    process.exit(0);
  } catch (error) {
    console.error('Error setting custom claims:', error);
    process.exit(1);
  }
}

setAdmin();
