import { getApps, getApp, initializeApp } from "firebase/app";
import { getFunctions, httpsCallable } from "firebase/functions";

const firebaseConfig = {
 apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
 authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
 projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
 storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
 messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
 appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
 measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID,
};

const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
const functions = getFunctions(app, "us-central1");

/**
 * NEW: Consolidated API caller for Admin Panel.
 */
export const callApi = async (action: string, data: any = {}) => {
  const apiFunction = httpsCallable(functions, 'api');
  try {
    const result = await apiFunction({ action, ...data });
    return result.data;
  } catch (error: any) {
    console.error(`[Admin API Error] Action: ${action}`, error);
    throw error;
  }
};

export { functions };
