import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { db, admin } from "../utils/firebase";

export const createUserRecord = onCall({ region: "asia-south1", cors: true }, async (request) => {
    const uid = request.auth?.uid || request.data.uid;

    if (!uid) {
        throw new HttpsError("unauthenticated", "User must be authenticated to create a profile.");
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
        platform // Added platform field
    } = request.data;

    try {
        await db.collection("users").doc(uid).set({
            uid: uid,
            email: email || null,
            username: username || null,
            fullName: fullName || null,
            profileImageUrl: avatarUrl || null,
            dob: dob || null,
            phone: phone || null,
            occupation: occupation || null,
            gender: gender || null,
            following: following || [],
            platform: platform || "unknown", // Save platform info
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });

        return { success: true };
    } catch (error) {
        logger.error("Error creating user record:", error);
        throw new HttpsError("internal", "Could not create user record.");
    }
});