import { db, isAdmin } from "./utils/firebase";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { FieldValue } from "firebase-admin/firestore";
import { setGlobalOptions } from "firebase-functions/v2";

// OPTIMIZED GLOBAL OPTIONS FOR QUOTA MANAGEMENT
// Concurrency requires at least 1 CPU.
setGlobalOptions({ 
    region: 'us-central1', 
    cpu: 1, // Must be >= 1 for concurrency
    memory: '256MiB', 
    maxInstances: 1, // Strict limit to prevent quota explosion
    concurrency: 80 // Allow up to 80 requests per instance
});

// --- EXPORT ALL MODULES ---

// 1. Auth & User Profile
export * from "./auth/authHandler";
export * from "./user/emailUpdate";
export * from "./user/phoneUpdate";
export * from "./user/toggleFollow";
export * from "./user/rewards"; 

// 2. Contests, Matches & Voting
export * from "./contests/matchHandler";
export * from "./contests/voting";
export * from "./contests/cron";
export * from "./contests/contestHandler"; 

// 3. Posts & Stories
export * from "./posts/index";
export * from "./stories/index";

// 4. Wallet & Payments
export * from "./wallet/topup";
export * from "./wallet/adminWalletManagement";

// 5. Notifications & Messaging
export * from "./notifications/index";
export * from "./admin/notifications";

// 6. Admin Tools
export * from "./admin/index";

// 7. Storage & Utilities
export * from "./storage/presignedUrl";


// --- INLINE FUNCTIONS (Existing in index.ts) ---

/**
 * ADMIN: Create a new Contest Template
 */
export const createContestTemplate = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Auth required.");
  const isUserAdmin = await isAdmin(request.auth.uid);
  if (!isUserAdmin) throw new HttpsError("permission-denied", "Admin only.");

  const data = request.data;
  const contestRef = db.collection("contests").doc();
  await contestRef.set({
    ...data,
    status: "live", 
    createdAt: FieldValue.serverTimestamp(),
    createdBy: request.auth.uid,
  });

  return { success: true, contestId: contestRef.id };
});

/**
 * ADMIN: God View Dashboard Stats
 */
export const getAdminStats = onCall(async (request) => {
  if (!request.auth || !(await isAdmin(request.auth.uid))) {
    throw new HttpsError("permission-denied", "Admin only.");
  }

  const usersCount = (await db.collection("users").count().get()).data().count;
  const activeMatches = (await db.collection("contestMatches").where("status", "==", "active").count().get()).data().count;
  const waitingMatches = (await db.collection("contestMatches").where("status", "==", "waiting_for_opponent").count().get()).data().count;
  
  const latestTransactions = await db.collection("coinTransactions")
    .orderBy("timestamp", "desc")
    .limit(10)
    .get();

  return {
    stats: { usersCount, activeMatches, waitingMatches },
    latestTransactions: latestTransactions.docs.map(doc => ({ id: doc.id, ...doc.data() }))
  };
});
