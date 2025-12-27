import { initializeApp, getApps, getApp } from "firebase/app";
import { getFunctions, httpsCallable } from "firebase/functions";
import { Report } from "@/app/reports/page";

// WARNING: This file contains a Firebase initialization that conflicts with
// the central configuration in `admin/src/lib/firebase/config.ts`.
// Restoring this code will likely cause the "INTERNAL ASSERTION FAILED" crash.

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
const functions = getFunctions(app, "asia-south1");

export const getReports = async ({
  timeframe,
  sort,
}: {
  timeframe: string;
  sort: string;
}): Promise<Report[]> => {
  try {
    const getReportsCallable = httpsCallable(functions, "getReports");
    const response = await getReportsCallable({ timeframe, sort });
    return response.data as Report[];
  } catch (error) {
    console.error("Error fetching reports:", error);
    return [];
  }
};
