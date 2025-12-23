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
  initializeFirestore, 
  Firestore, 
  persistentLocalCache, 
  memoryLocalCache 
} from "firebase/firestore";
import { firebaseConfig } from "@/src/firebaseConfig";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";

// This pattern ensures that all Firebase services are initialized only once.
const app: FirebaseApp = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();

// Initialize Auth with platform-specific persistence
let auth: Auth;

if (getApps().length === 0) {
  if (Platform.OS === 'web') {
    auth = initializeAuth(app, {
      persistence: [indexedDBLocalPersistence, browserLocalPersistence],
    });
  } else {
    auth = initializeAuth(app, {
      persistence: getReactNativePersistence(AsyncStorage),
    });
  }
} else {
  auth = getAuth(app);
}

// Initialize Firestore, ensuring it always connects to the correct database.
let firestore: Firestore;
try {
  if (Platform.OS === 'web') {
    firestore = initializeFirestore(app, {
      databaseId: "dpcontest",
      cache: persistentLocalCache({ tabManager: 'local' }),
      experimentalForceLongPolling: true,
    });
  } else {
     firestore = initializeFirestore(app, {
      databaseId: "dpcontest",
      cache: persistentLocalCache({}),
    });
  }
} catch (error) {
  console.warn("Retrying Firestore initialization...", error);
  // Fallback to memory cache if persistence fails.
  firestore = initializeFirestore(app, {
    databaseId: "dpcontest",
    cache: memoryLocalCache({}),
    ...(Platform.OS === 'web' && { experimentalForceLongPolling: true }),
  });
}

// Initialize and export Functions
export const functions = getFunctions(app, "asia-south1");

// Export the initialized services
export { firestore, auth };
export default app;
