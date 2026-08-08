import { initializeApp, getApps, getApp, FirebaseApp } from "firebase/app";
import {
  initializeAuth,
  indexedDBLocalPersistence,
  browserLocalPersistence,
  Auth,
  getAuth,
} from "firebase/auth";
// getReactNativePersistence only exists in Firebase's react-native build and is
// not in the umbrella type declarations, so access it dynamically to keep types
// happy while Metro resolves the correct RN implementation at runtime.
import * as firebaseAuth from "firebase/auth";
const getReactNativePersistence = (firebaseAuth as any).getReactNativePersistence as (
  storage: unknown,
) => any;
import { firebaseConfig } from "@/src/firebaseConfig";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";

// Import Firebase Compat for legacy libraries (Like expo-firebase-recaptcha)
import firebase from 'firebase/compat/app';
import 'firebase/compat/auth';

// 1. Initialize Modular App
const app: FirebaseApp = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();

// 2. Initialize Compat App (Required for expo-firebase-recaptcha)
if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}

// 3. Initialize Auth with Persistence.
// NOTE: The previous guard used `getApps().length === 0`, but an app was always
// created above, so this branch never ran and persistence was never configured
// (auth silently fell back to in-memory -> users logged out on restart).
// initializeAuth throws if auth is already initialized (e.g. Fast Refresh), so
// we try it and fall back to getAuth.
let auth: Auth;
try {
    auth = initializeAuth(app, {
        persistence:
            Platform.OS === 'web'
                ? [indexedDBLocalPersistence, browserLocalPersistence]
                : getReactNativePersistence(AsyncStorage),
    });
} catch {
    auth = getAuth(app);
}

// Firebase is used ONLY for Authentication. Data/storage/functions are on
// Cloudflare (Worker + D1 + R2) and accessed via services/api + services/realtime.
export { auth, app };
export default app;
