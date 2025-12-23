
const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json'); // You'll need to provide this or I'll use default env

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const email = 'tophuntinfo@gmail.com';

admin.auth().getUserByEmail(email)
  .then((userRecord) => {
    return admin.auth().setCustomUserClaims(userRecord.uid, { role: 'admin' });
  })
  .then(() => {
    console.log(`Successfully set admin role for user: ${email}`);
    process.exit(0);
  })
  .catch((error) => {
    console.error('Error setting custom claims:', error);
    process.exit(1);
  });
