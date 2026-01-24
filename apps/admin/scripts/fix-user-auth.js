
const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

async function checkAndFixUser(email) {
  try {
    const user = await admin.auth().getUserByEmail(email);
    console.log(`User found: ${user.uid}`);
    console.log('Providers:', user.providerData.map(p => p.providerId));
    
    // Check if password provider exists
    const hasPasswordProvider = user.providerData.some(p => p.providerId === 'password');
    
    if (hasPasswordProvider) {
      console.log('User has password provider. Resetting password to: Tophunt@123');
      await admin.auth().updateUser(user.uid, {
        password: 'Tophunt@123'
      });
      console.log('Password updated successfully.');
    } else {
      console.log('User DOES NOT have password provider. Adding it by setting a password...');
      await admin.auth().updateUser(user.uid, {
        password: 'Tophunt@123'
      });
      console.log('Password provider added successfully.');
    }
  } catch (error) {
    console.error('Error:', error.message);
  }
}

const emailToFix = 'tophuntinfo@gmail.com';
checkAndFixUser(emailToFix);
