import * as admin from "firebase-admin";
import { getFirestore } from "firebase-admin/firestore";

if (admin.apps.length === 0) {
  admin.initializeApp();
}

export const db = getFirestore();
export const auth = admin.auth();

export const isAdmin = async (uid: string) => {
  const userDoc = await db.collection("users").doc(uid).get();
  return userDoc.exists && userDoc.data()?.role === "admin";
};

export { admin };
