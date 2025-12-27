
const admin = require('firebase-admin');
const dotenv = require('dotenv');
const path = require('path');

// Load env from .env.local in the parent directory of this script
dotenv.config({ path: path.join(__dirname, '../.env.local') });

const projectId = process.env.FIREBASE_PROJECT_ID;
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
const privateKey = process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined;

if (!projectId || !clientEmail || !privateKey) {
  console.error('Missing environment variables. Check .env.local');
  process.exit(1);
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId,
      clientEmail,
      privateKey,
    }),
  });
}

const email = 'tophuntinfo@gmail.com';

async function setAdmin() {
  try {
    const user = await admin.auth().getUserByEmail(email);
    await admin.auth().setCustomUserClaims(user.uid, { role: 'admin' });
    console.log(`Successfully set admin role for user: ${email}`);
    
    // Verify
    const updatedUser = await admin.auth().getUserByEmail(email);
    console.log('User custom claims:', updatedUser.customClaims);
  } catch (error) {
    console.error('Error setting custom claims:', error);
    if (error.code === 'auth/user-not-found') {
      console.log('User not found. Please create the user in Firebase Auth first.');
    }
  } finally {
    process.exit();
  }
}

setAdmin();
