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

// 2. Initialize Auth with Persistence
let auth: Auth;
try {
  if (Platform.OS === 'web') {
    auth = initializeAuth(app, { 
      persistence: [indexedDBLocalPersistence, browserLocalPersistence] 
    });
  } else {
    auth = initializeAuth(app, { 
      persistence: getReactNativePersistence(AsyncStorage) 
    });
  }
  console.log("[Firebase] Auth initialized with persistence.");
} catch (e) {
  // If already initialized, use getAuth
  auth = getAuth(app);
  console.log("[Firebase] Auth already initialized, using existing instance.");
}

// 3. Initialize Firestore
let firestore: Firestore;
try {
  firestore = getFirestore(app);
} catch (e) {
  firestore = initializeFirestore(app, {});
}

export const functions = getFunctions(app, "us-central1"); 
export { firestore, auth };
export default app;
