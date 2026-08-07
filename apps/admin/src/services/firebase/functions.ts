import { getApps, getApp, initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFunctions } from "firebase/functions";

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
 * Consolidated API caller for the Admin Panel — now targets the Cloudflare
 * Worker backend. Firebase Auth is still used: the admin's ID token is sent as
 * a Bearer token and the Worker enforces the admin role.
 *
 * Set NEXT_PUBLIC_API_URL to the deployed Worker URL.
 */
const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL || "https://tophunt-api.workers.dev";

const AUTH_ACTIONS = new Set([
  "check",
  "create",
  "createProfile",
  "getUserByIdentifier",
  "sendOtpToPhone",
  "verifyOtp",
  "updatePasswordWithPhone",
  "sendEmailOtp",
  "verifyEmailOtp",
  "sendPhoneOtp",
  "verifyPhoneOtp",
]);

class ApiCallError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export const callApi = async (action: string, data: any = {}) => {
  const path = AUTH_ACTIONS.has(action) ? "/auth" : "/api";
  const headers: Record<string, string> = { "Content-Type": "application/json" };

  const currentUser = getAuth(app).currentUser;
  if (currentUser) {
    try {
      headers["Authorization"] = `Bearer ${await currentUser.getIdToken()}`;
    } catch {
      /* proceed without token */
    }
  }

  try {
    const res = await fetch(`${API_BASE_URL}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ action, ...data }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const status = (json?.error?.status || "INTERNAL").toLowerCase().replace(/_/g, "-");
      throw new ApiCallError(`functions/${status}`, json?.error?.message || "Request failed");
    }
    return json;
  } catch (error: any) {
    console.error(`[Admin API Error] Action: ${action}`, error);
    throw error;
  }
};

export { functions };
