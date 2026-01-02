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

// 3. Initialize Firestore (Default Database)
// Migrated from "dpcontest" to default database
let firestore: Firestore;

try {
  // Use the default database
  firestore = getFirestore(app);
  console.log("[Firebase] Using default Firestore instance");
} catch (e) {
  try {
    // If not initialized, initialize default
    firestore = initializeFirestore(app, {});
    console.log("[Firebase] Initialized default Firestore");
  } catch (err) {
    console.error("[Firebase] Firestore init failed:", err);
    throw err;
  }
}

// Note: Cloud Functions region should ideally match your backend deployment (us-central1 now recommended)
// Keeping asia-south1 if that's where your old functions are, but standardizing to us-central1 is better for cost.
// If you updated functions to us-central1, change this too.
export const functions = getFunctions(app, "us-central1"); 
export { firestore, auth };
export default app;
