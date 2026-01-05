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
    maxInstances: 1, // REDUCED TO 1 to save quota
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

/**
 * Helper to get Reward Settings from DB
 */
async function getRewardSettings() {
  const configDoc = await db.collection("settings").doc("appConfig").get();
  return configDoc.data()?.rewardSettings || { signupBonus: 100 };
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

      if (type === "phone") {
        const normalized = normalizePhoneNumber(value);
        if (!normalized) {
             throw new HttpsError("invalid-argument", "Invalid phone format");
        }
        value = normalized;
      } else if (type === "username") {
        try {
            value = validateUsername(value);
        } catch (e: any) {
             throw e;
        }
      } else if (type === "email") {
        value = value.toLowerCase();
        if (isDisposableEmail(value)) {
            throw new HttpsError("invalid-argument", "Temporary or disposable email addresses are not allowed.");
        }
      }

      logger.info(`[authHandler] Checking ${type}: ${value}`);

      try {
        let exists = false;

        // Specialized check for Email using Admin Auth
        if (type === "email") {
          try {
            await admin.auth().getUserByEmail(value);
            exists = true;
          } catch (error: any) {
            if (error.code === 'auth/user-not-found') {
              exists = false;
            } else {
              throw error;
            }
          }
        }

        // If not already found in Auth (or if checking phone/username), check Firestore
        if (!exists) {
          const snapshot = await db
            .collection("users")
            .where(type, "==", value)
            .limit(1)
            .get();
          exists = !snapshot.empty;
        }

        return { exists };
      } catch (error: any) {
        logger.error(`[authHandler] Check failed for ${type}:`, error);
        throw new HttpsError(
          "internal",
          "Error while checking uniqueness."
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
        coordinates, // NEW
      } = request.data;

      if (!email || !password || !username) {
        throw new HttpsError(
          "invalid-argument",
          "Email, password, and username are required for user creation."
        );
      }
      
      if (isDisposableEmail(email)) {
          throw new HttpsError("invalid-argument", "Temporary or disposable email addresses are not allowed.");
      }

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
        const rewardSettings = await getRewardSettings();
        const signupBonus = rewardSettings.signupBonus || 0;

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
          platform,
          coordinates // NEW
        }, signupBonus);
        
        logger.info(`[authHandler] User created successfully: ${uid}`);
        return { status: "success", uid, message: "User created successfully" };
      } catch (error) {
        logger.error(
          `[authHandler] Firestore creation failed for ${uid}. Rolling back auth.`,
          error
        );
        await admin.auth().deleteUser(uid).catch(() => {});
        throw new HttpsError(
          "internal",
          "Failed to save user profile. Account creation cancelled."
        );
      }
    }

    // ---------------------------------------------------------
    // ACTION: CREATE PROFILE (Firestore Only - for Social Auth or Phone Auth)
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
        coordinates, // NEW
      } = request.data;
      
      if (email && isDisposableEmail(email)) {
           throw new HttpsError("invalid-argument", "Temporary or disposable email addresses are not allowed.");
      }

      const validatedUsername = username ? validateUsername(username) : null;

      logger.info(`[authHandler] Creating profile for existing UID: ${uid}`);

      try {
        const rewardSettings = await getRewardSettings();
        const signupBonus = rewardSettings.signupBonus || 0;

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
          platform,
          coordinates // NEW
        }, signupBonus);
        return { status: "success", uid, message: "Profile created successfully" };
      } catch (error) {
        logger.error("[authHandler] Error creating user profile:", error);
        throw new HttpsError("internal", "Could not create user record.");
      }
    }

    throw new HttpsError("invalid-argument", `Unknown action: ${action}`);
  }
);

/**
 * GET USER BY IDENTIFIER (Email or Phone)
 * Used in Forgot Password flow to verify user exists and get their basic info
 */
export const getUserByIdentifier = onCall(AUTH_CONFIG, async (request) => {
    const { identifier, type } = request.data;

    if (!identifier || !type) {
        throw new HttpsError("invalid-argument", "Identifier and type are required.");
    }

    let queryField = type === 'email' ? 'email' : 'phone';
    let value = identifier;

    if (type === 'phone') {
        const normalized = normalizePhoneNumber(identifier);
        if (!normalized) throw new HttpsError("invalid-argument", "Invalid phone format.");
        value = normalized;
    } else {
        value = identifier.toLowerCase();
    }

    try {
        const snapshot = await db.collection("users")
            .where(queryField, "==", value)
            .limit(1)
            .get();

        if (snapshot.empty) {
            return { found: false };
        }

        const userDoc = snapshot.docs[0];
        const userData = userDoc.data();

        return {
            found: true,
            user: {
                uid: userDoc.id,
                name: userData.fullName || userData.username,
                avatar: userData.profileImageUrl || null
            }
        };
    } catch (error: any) {
        logger.error("[getUserByIdentifier] Error:", error);
        throw new HttpsError("internal", "Error searching for user.");
    }
});

/**
 * SEND OTP TO PHONE (Forgot Password)
 */
export const sendOtpToPhone = onCall(AUTH_CONFIG, async (request) => {
    const { phone } = request.data;
    if (!phone) throw new HttpsError("invalid-argument", "Phone number is required.");

    const normalizedPhone = normalizePhoneNumber(phone);
    if (!normalizedPhone) throw new HttpsError("invalid-argument", "Invalid phone format.");

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = admin.firestore.Timestamp.fromMillis(Date.now() + 10 * 60 * 1000); // 10 mins

    try {
        // Store OTP in a secure collection
        await db.collection("passwordResetOtps").doc(normalizedPhone).set({
            otp,
            expiresAt,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        // Send SMS via Twilio
        try {
            const sid = process.env.TWILIO_ACCOUNT_SID;
            const token = process.env.TWILIO_AUTH_TOKEN;
            const from = process.env.TWILIO_PHONE_NUMBER;

            if (sid && token && from) {
                const client = require("twilio")(sid, token);
                await client.messages.create({
                    body: `Your Password Reset OTP is: ${otp}. Valid for 10 minutes.`,
                    from: from,
                    to: normalizedPhone,
                });
            } else {
                logger.warn("Twilio credentials missing. OTP generated but not sent: ", otp);
            }
        } catch (smsError) {
            logger.error("SMS Sending failed:", smsError);
        }

        return { success: true };
    } catch (error: any) {
        throw new HttpsError("internal", error.message);
    }
});

/**
 * VERIFY OTP (Forgot Password)
 */
export const verifyOtp = onCall({ ...AUTH_CONFIG, minInstances: 0, maxInstances: 1 }, async (request) => {
    const { phone, code } = request.data;
    if (!phone || !code) throw new HttpsError("invalid-argument", "Phone and code are required.");

    const normalizedPhone = normalizePhoneNumber(phone);
    if (!normalizedPhone) throw new HttpsError("invalid-argument", "Invalid phone format.");

    const otpDoc = await db.collection("passwordResetOtps").doc(normalizedPhone).get();

    if (!otpDoc.exists) {
        throw new HttpsError("not-found", "No OTP request found for this phone.");
    }

    const data = otpDoc.data();
    if (data?.otp !== code) {
        throw new HttpsError("invalid-argument", "Invalid OTP code.");
    }

    if (data?.expiresAt.toMillis() < Date.now()) {
        throw new HttpsError("deadline-exceeded", "OTP has expired.");
    }

    // Success - OTP verified
    return { success: true };
});

/**
 * UPDATE PASSWORD WITH PHONE (Forgot Password Final Step)
 */
export const updatePasswordWithPhone = onCall({ ...AUTH_CONFIG, minInstances: 0, maxInstances: 1 }, async (request) => {
    const { phone, newPassword } = request.data;
    if (!phone || !newPassword) throw new HttpsError("invalid-argument", "Phone and new password are required.");

    const normalizedPhone = normalizePhoneNumber(phone);
    if (!normalizedPhone) throw new HttpsError("invalid-argument", "Invalid phone format.");

    // 1. Verify OTP was indeed verified
    const otpDoc = await db.collection("passwordResetOtps").doc(normalizedPhone).get();
    if (!otpDoc.exists) {
        throw new HttpsError("permission-denied", "OTP verification required.");
    }

    try {
        // 2. Find the user by phone
        const userSnapshot = await db.collection("users").where("phone", "==", normalizedPhone).limit(1).get();
        if (userSnapshot.empty) {
            throw new HttpsError("not-found", "User not found.");
        }
        const uid = userSnapshot.docs[0].id;

        // 3. Update Auth Password
        await admin.auth().updateUser(uid, {
            password: newPassword
        });

        // 4. Clean up OTP doc
        await db.collection("passwordResetOtps").doc(normalizedPhone).delete();

        return { success: true };
    } catch (error: any) {
        logger.error("Update password failed:", error);
        throw new HttpsError("internal", error.message);
    }
});

// Helper function to keep code DRY
async function createFirestoreProfile(uid: string, data: any, signupBonus: number = 0) {
  const userRef = db.collection("users").doc(uid);
  
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
    coordinates: data.coordinates || null, // ADDED
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    signupCompleted: true, // Mark as completed
    Dpcoin: signupBonus, // Initial Bonus from Admin Config
    xp: 0,
    level: 1, 
    stats: {
       followersCount: 0, 
       followingCount: 0, 
       wins: 0,
       totalVotesReceived: 0,
       contestsJoined: 0,
    }
  };

  await userRef.set(profileData, { merge: true });

  // Record Signup Bonus Transaction if > 0
  if (signupBonus > 0) {
    await db.collection("coinTransactions").add({
        uid,
        amount: signupBonus,
        type: "signup_bonus",
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        description: "Welcome bonus for joining TopHunt!"
    });
  }
}
