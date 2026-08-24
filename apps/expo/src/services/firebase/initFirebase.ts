import { initializeApp, getApps, getApp, FirebaseApp } from "firebase/app";
import {
  initializeAuth,
  indexedDBLocalPersistence,
  browserLocalPersistence,
  browserPopupRedirectResolver,
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

// NOTE: firebase/compat used to be imported here purely to satisfy
// expo-firebase-recaptcha. Phone sign-in now goes through our own Worker (OTP +
// custom token), so the compat layer — and roughly a second copy of the Firebase
// auth bundle — is gone.

// 1. Initialize Modular App
const app: FirebaseApp = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();

// 2. Initialize Auth with Persistence.
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
        // On web, signInWithPopup/Redirect need a resolver at init time —
        // without it Firebase throws auth/argument-error.
        ...(Platform.OS === 'web' ? { popupRedirectResolver: browserPopupRedirectResolver } : {}),
    });
} catch {
    auth = getAuth(app);
}

// Firebase is used ONLY for Authentication. Data/storage/functions are on
// Cloudflare (Worker + D1 + R2) and accessed via services/api + services/realtime.
export { auth, app };
export default app;
