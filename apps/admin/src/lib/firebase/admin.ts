import * as admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';

let firebaseAdminApp: admin.app.App;

if (!admin.apps.length) {
  try {
    firebaseAdminApp = admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }),
    });
  } catch (error) {
    console.error('Firebase admin initialization error', error);
    throw new Error('Failed to initialize Firebase Admin SDK');
  }
} else {
  firebaseAdminApp = admin.app();
}

export const app = firebaseAdminApp; // Export the initialized app
export const db = getFirestore(firebaseAdminApp);
export const auth = admin.auth(firebaseAdminApp);
export const storage = admin.storage(firebaseAdminApp);
