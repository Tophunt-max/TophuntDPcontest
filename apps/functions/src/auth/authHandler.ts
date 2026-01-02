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

// Common disposable email domains to block
const DISPOSABLE_DOMAINS = new Set([
  "yopmail.com", "mailinator.com", "temp-mail.org", "10minutemail.com",
  "guerrillamail.com", "sharklasers.com", "maildrop.cc", "getnada.com",
  "dispostable.com", "tempmail.com", "throwawaymail.com", "mail.tm",
  "temp-mail.io", "yopmail.net", "cool.fr.nf", "jetable.org", "temporarily.de",
  "tempmailo.com", "smailpro.com", "trashmail.com", "luxusmail.org"
]);

// Reserved usernames that cannot be claimed
const RESERVED_USERNAMES = new Set([
  "admin", "administrator", "root", "system", "support", "help", "info",
  "contact", "webmaster", "security", "privacy", "policy", "terms",
  "login", "logout", "signin", "signup", "register", "auth", "user",
  "users", "profile", "settings", "config", "api", "dev", "test",
  "null", "undefined", "true", "false", "void", "anon", "anonymous",
  "official", "staff", "moderator"
]);

const USERNAME_REGEX = /^[a-zA-Z0-9_.]+$/;

// Helper to normalize phone numbers (remove spaces, dashes, parens)
function normalizePhoneNumber(phone: string | null | undefined): string | null {
    if (!phone) return null;
    // Remove spaces, dashes, parentheses
    // Keep '+' at the start if present, and digits
    // Regex: Replace anything that is NOT a digit or a '+' with empty string
    return phone.replace(/[^\d+]/g, "").trim();
}

// Helper to check for disposable emails
function isDisposableEmail(email: string): boolean {
    if (!email) return false;
    const domain = email.split('@')[1];
    if (!domain) return false;
    return DISPOSABLE_DOMAINS.has(domain.toLowerCase());
}

// Helper to validate username
function validateUsername(username: string): string {
    const lower = username.toLowerCase();
    
    if (lower.length < 3) {
        throw new HttpsError("invalid-argument", "Username must be at least 3 characters long.");
    }

    if (lower.length > 30) {
        throw new HttpsError("invalid-argument", "Username must be less than 30 characters long.");
    }

    if (!USERNAME_REGEX.test(username)) {
        throw new HttpsError("invalid-argument", "Username can only contain letters, numbers, underscores, and dots.");
    }

    if (RESERVED_USERNAMES.has(lower)) {
        throw new HttpsError("invalid-argument", "This username is reserved and cannot be used.");
    }

    return lower;
}

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

      let value = request.data.value?.trim();
      if (!value) {
        throw new HttpsError(
          "invalid-argument",
          `Missing value for check type: ${type}`
        );
      }

      // IMPROVED: Normalize phone number before checking
      if (type === "phone") {
        const normalized = normalizePhoneNumber(value);
        if (!normalized) {
             throw new HttpsError("invalid-argument", "Invalid phone format");
        }
        value = normalized;
      } else if (type === "username") {
        // IMPROVED: Validate username
        try {
            value = validateUsername(value);
        } catch (e: any) {
            // For check action, if invalid format/reserved, consider it "exists" (unavailable) or throw error
            // Throwing error is better so client knows WHY it's unavailable
             throw e;
        }
      } else if (type === "email") {
        value = value.toLowerCase();
        // IMPROVED: Check for disposable email
        if (isDisposableEmail(value)) {
            throw new HttpsError("invalid-argument", "Temporary or disposable email addresses are not allowed.");
        }
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
      
      // IMPROVED: Check for disposable email
      if (isDisposableEmail(email)) {
          throw new HttpsError("invalid-argument", "Temporary or disposable email addresses are not allowed.");
      }

      // IMPROVED: Validate username
      const validatedUsername = validateUsername(username);

      logger.info(`[authHandler] Creating user: ${email}`);

      // Create Auth User
      let userRecord;
      try {
        userRecord = await admin.auth().createUser({
          email,
          password,
          displayName: validatedUsername,
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
          username: validatedUsername,
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
      
      // IMPROVED: Check for disposable email
      if (email && isDisposableEmail(email)) {
           throw new HttpsError("invalid-argument", "Temporary or disposable email addresses are not allowed.");
      }

      // IMPROVED: Validate username
      const validatedUsername = username ? validateUsername(username) : null;

      logger.info(`[authHandler] Creating profile for existing UID: ${uid}`);

      try {
        await createFirestoreProfile(uid, {
          email,
          username: validatedUsername,
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
  
  // Normalize phone before saving
  const normalizedPhone = normalizePhoneNumber(data.phone);

  const profileData = {
    uid,
    email: data.email || null,
    username: data.username ? data.username.toLowerCase() : null,
    fullName: data.fullName || null,
    profileImageUrl: data.avatarUrl || null,
    dob: data.dob || null,
    phone: normalizedPhone,
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
