
const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

async function checkUserProviders(email) {
  try {
    const user = await admin.auth().getUserByEmail(email);
    console.log(`User found: ${user.uid}`);
    console.log('Providers:', user.providerData.map(p => p.providerId));
  } catch (error) {
    console.error('Error fetching user:', error.message);
  }
}

// Replace with the email you are having trouble with
const emailToCheck = 'REPLACE_WITH_USER_EMAIL'; 
// checkUserProviders(emailToCheck);
