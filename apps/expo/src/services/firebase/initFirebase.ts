import { initializeApp, getApps, getApp, FirebaseApp } from "firebase/app";
import {
  initializeAuth,
  getReactNativePersistence,
  indexedDBLocalPersistence,
  browserLocalPersistence,
  Auth,
  getAuth,
} from "firebase/auth";
import { getFunctions } from "firebase/functions";
import { 
  getFirestore,
  Firestore,
  initializeFirestore,
  persistentLocalCache,
  memoryLocalCache
} from "firebase/firestore";
import { firebaseConfig } from "@/src/firebaseConfig";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";

// 1. Initialize App
const app: FirebaseApp = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();

// 2. Initialize Auth
let auth: Auth;
if (getApps().length === 0) {
  const persistence = Platform.OS === 'web' 
    ? [indexedDBLocalPersistence, browserLocalPersistence]
    : getReactNativePersistence(AsyncStorage);

  auth = initializeAuth(app, { persistence });
} else {
  auth = getAuth(app);
}

// 3. Initialize Firestore (Named Database: dpcontest)
let firestore: Firestore;
const DB_ID = "dpcontest";

try {
  // Try to get the specific database
  firestore = getFirestore(app, DB_ID);
  console.log("[Firebase] Using existing Firestore instance:", DB_ID);
} catch (e) {
  try {
    // If not initialized, initialize it
    firestore = initializeFirestore(app, {
      databaseId: DB_ID,
      cache: persistentLocalCache({ tabManager: 'local' }),
    });
    console.log("[Firebase] Initialized Firestore with ID:", DB_ID);
  } catch (err) {
    console.error("[Firebase] Firestore init failed:", err);
    // Final fallback to default
    firestore = getFirestore(app);
  }
}

export const functions = getFunctions(app, "asia-south1");
export { firestore, auth };
export default app;
