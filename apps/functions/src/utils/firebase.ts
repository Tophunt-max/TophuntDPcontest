import * as admin from "firebase-admin";
import { getFirestore } from "firebase-admin/firestore";

if (admin.apps.length === 0) {
  admin.initializeApp();
}

// Connect to the specific "dpcontest" database instance
export const dpDb = getFirestore(admin.app(), "dpcontest");

// Export db as dpDb to ensure all existing functions use the correct database
export const db = dpDb;
export const auth = admin.auth();
export { admin };
