import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";
import * as logger from "firebase-functions/logger";
import { db } from "../utils/firebase"; // Import the shared db instance

// Admin is already initialized in firebase.ts, so we don't need to do it here.

export const createUser = onCall({ region: "asia-south1", cors: true }, async (request) => {
  const { 
    email, password, username, fullName, avatarUrl, dob, phone,
    occupation, gender, following, platform 
  } = request.data;

  if (!email || !password || !username) {
    throw new HttpsError("invalid-argument", "Email, password, and username are required.");
  }
  
  logger.info(`[createUser] Starting for email: ${email}`);

  let userRecord;
  try {
    userRecord = await admin.auth().createUser({
      email: email,
      password: password,
      displayName: username,
      photoURL: avatarUrl || null,
    });
  } catch (error: any) {
    if (error.code === 'auth/email-already-exists') {
      logger.warn(`[createUser] Attempt to create an already existing email: ${email}`);
      throw new HttpsError('already-exists', 'This email is already registered.');
    }
    logger.error("[createUser] Error creating auth user:", error);
    throw new HttpsError("internal", "Could not create user account.");
  }

  const { uid } = userRecord;
  logger.info(`[createUser] Auth user created successfully: ${uid}`);

  try {
    // Use the imported 'db' instance
    const userRef = db.collection("users").doc(uid);
    
    const profileData = {
      uid,
      email: email,
      username: username.toLowerCase(),
      fullName: fullName || null,
      profileImageUrl: avatarUrl || null,
      dob: dob || null,
      phone: phone || null,
      occupation: occupation || null,
      gender: gender || null,
      following: following || [],
      platform: platform || "unknown",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    
    // Add detailed logging for the data being written
    logger.info(`[createUser] Writing to Firestore for user ${uid}`, { profileData });
    
    await userRef.set(profileData);
    
    logger.info(`[createUser] Firestore document created successfully for user: ${uid}`);

    return { status: "success", uid, message: "User created successfully" };

  } catch (error) {
    logger.error(`[createUser] Error creating Firestore doc for ${uid}. Rolling back.`, error);
    await admin.auth().deleteUser(uid);
    logger.info(`[createUser] Rolled back auth user: ${uid}`);
    throw new HttpsError("internal", "Failed to save user profile. The operation was cancelled.");
  }
});
