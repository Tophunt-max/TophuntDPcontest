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
} from "firebase/firestore";
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

// 3. Initialize Auth with Persistence
let auth: Auth;
if (getApps().length === 0) {
    if (Platform.OS === 'web') {
        auth = initializeAuth(app, { 
            persistence: [indexedDBLocalPersistence, browserLocalPersistence] 
        });
    } else {
        auth = initializeAuth(app, { 
            persistence: getReactNativePersistence(AsyncStorage) 
        });
    }
} else {
    auth = getAuth(app);
}

// 4. Initialize Firestore
const firestore: Firestore = getFirestore(app);
const functions = getFunctions(app, "us-central1"); 

export { firestore, auth, app, functions };
export default app;
