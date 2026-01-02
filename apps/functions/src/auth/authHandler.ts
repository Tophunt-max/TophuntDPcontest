import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";
import * as logger from "firebase-functions/logger";
import { db } from "../utils/firebase";
import { MemoryOption } from "firebase-functions/v2/options";

// CPU must be >= 1 for concurrency
const AUTH_CONFIG = {
    region: "us-central1",
    cpu: 1, 
    concurrency: 80, // Can handle many requests
    minInstances: 0,
    maxInstances: 2,
    memory: "256MiB" as MemoryOption,
    timeoutSeconds: 60,
    cors: true,
};

export const authHandler = onCall(AUTH_CONFIG, async (request) => {
    // 1. Basic validation
    if (!request.data || !request.data.action) {
      throw new HttpsError(
        "invalid-argument",
        "Request must specify an 'action' ('check', 'create', 'createProfile')."
      );
    }

    const { action, type } = request.data;

    // ---------------------------------------------------------
    // ACTION: CHECK (email, phone, username)
    // ---------------------------------------------------------
    if (action === "check") {
      if (!type || !["email", "phone", "username"].includes(type)) {
        throw new HttpsError(
          "invalid-argument",
          "For check action, 'type' must be 'email', 'phone', or 'username'."
        );
      }

      const value = request.data.value?.trim();
      if (!value) {
        throw new HttpsError(
          "invalid-argument",
          `Missing value for check type: ${type}`
        );
      }

      logger.info(`[authHandler] Checking ${type}: ${value}`);

      try {
        const snapshot = await db
          .collection("users")
          .where(type, "==", value)
          .limit(1)
          .get();

        const exists = !snapshot.empty;
        return { exists };
      } catch (error: any) {
        logger.error(`[authHandler] Check failed for ${type}:`, error);
        throw new HttpsError(
          "internal",
          "Database error while checking uniqueness."
        );
      }
    }

    // ---------------------------------------------------------
    // ACTION: CREATE USER (Auth + Profile)
    // ---------------------------------------------------------
    if (action === "create") {
      const {
        email,
        password,
        username,
        fullName,
        avatarUrl,
        dob,
        phone,
        occupation,
        gender,
        following,
        platform,
      } = request.data;

      if (!email || !password || !username) {
        throw new HttpsError(
          "invalid-argument",
          "Email, password, and username are required for user creation."
        );
      }

      logger.info(`[authHandler] Creating user: ${email}`);

      // Create Auth User
      let userRecord;
      try {
        userRecord = await admin.auth().createUser({
          email,
          password,
          displayName: username,
          photoURL: avatarUrl || null,
        });
      } catch (error: any) {
        if (error.code === "auth/email-already-exists") {
          throw new HttpsError("already-exists", "This email is already registered.");
        }
        logger.error("[authHandler] Auth creation failed:", error);
        throw new HttpsError("internal", "Could not create user account.");
      }

      const uid = userRecord.uid;

      // Create Firestore Profile
      try {
        await createFirestoreProfile(uid, {
          email,
          username,
          fullName,
          avatarUrl,
          dob,
          phone,
          occupation,
          gender,
          following,
          platform
        });
        
        logger.info(`[authHandler] User created successfully: ${uid}`);
        return { status: "success", uid, message: "User created successfully" };
      } catch (error) {
        logger.error(
          `[authHandler] Firestore creation failed for ${uid}. Rolling back auth.`,
          error
        );
        // Rollback Auth User if Firestore fails
        await admin.auth().deleteUser(uid).catch(() => {});
        throw new HttpsError(
          "internal",
          "Failed to save user profile. Account creation cancelled."
        );
      }
    }

    // ---------------------------------------------------------
    // ACTION: CREATE PROFILE (Firestore Only - for Social Auth)
    // ---------------------------------------------------------
    if (action === "createProfile") {
      const uid = request.auth?.uid || request.data.uid;
      
      if (!uid) {
         throw new HttpsError("unauthenticated", "User must be authenticated or provide UID.");
      }

      const {
        email,
        username,
        fullName,
        avatarUrl,
        dob,
        phone,
        occupation,
        gender,
        following,
        platform,
      } = request.data;

      logger.info(`[authHandler] Creating profile for existing UID: ${uid}`);

      try {
        await createFirestoreProfile(uid, {
          email,
          username,
          fullName,
          avatarUrl,
          dob,
          phone,
          occupation,
          gender,
          following,
          platform
        });
        return { success: true };
      } catch (error) {
        logger.error("[authHandler] Error creating user profile:", error);
        throw new HttpsError("internal", "Could not create user record.");
      }
    }

    // ---------------------------------------------------------
    // INVALID ACTION
    // ---------------------------------------------------------
    throw new HttpsError("invalid-argument", `Unknown action: ${action}`);
  }
);

// Helper function to keep code DRY
async function createFirestoreProfile(uid: string, data: any) {
  const userRef = db.collection("users").doc(uid);
  
  const profileData = {
    uid,
    email: data.email || null,
    username: data.username ? data.username.toLowerCase() : null,
    fullName: data.fullName || null,
    profileImageUrl: data.avatarUrl || null,
    dob: data.dob || null,
    phone: data.phone || null,
    occupation: data.occupation || null,
    gender: data.gender || null,
    following: data.following || [],
    platform: data.platform || "unknown",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    // Initialize gamification stats and other defaults
    fishCoins: 0,
    level: 0, // Initialize XP level
    stats: {
       followersCount: 0, // Initialize followers count
       followingCount: 0, // Initialize following count
       wins: 0,
       totalVotesReceived: 0,
       contestsJoined: 0,
    }
  };

  await userRef.set(profileData, { merge: true });
}
