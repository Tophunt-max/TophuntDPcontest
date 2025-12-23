"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.createUser = void 0;
const https_1 = require("firebase-functions/v2/https");
const admin = __importStar(require("firebase-admin"));
const logger = __importStar(require("firebase-functions/logger"));
const firebase_1 = require("../utils/firebase"); // Import the shared db instance
// Admin is already initialized in firebase.ts, so we don't need to do it here.
exports.createUser = (0, https_1.onCall)({ region: "asia-south1", cors: true }, async (request) => {
    const { email, password, username, fullName, avatarUrl, dob, phone, occupation, gender, following, platform } = request.data;
    if (!email || !password || !username) {
        throw new https_1.HttpsError("invalid-argument", "Email, password, and username are required.");
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
    }
    catch (error) {
        if (error.code === 'auth/email-already-exists') {
            logger.warn(`[createUser] Attempt to create an already existing email: ${email}`);
            throw new https_1.HttpsError('already-exists', 'This email is already registered.');
        }
        logger.error("[createUser] Error creating auth user:", error);
        throw new https_1.HttpsError("internal", "Could not create user account.");
    }
    const { uid } = userRecord;
    logger.info(`[createUser] Auth user created successfully: ${uid}`);
    try {
        // Use the imported 'db' instance
        const userRef = firebase_1.db.collection("users").doc(uid);
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
    }
    catch (error) {
        logger.error(`[createUser] Error creating Firestore doc for ${uid}. Rolling back.`, error);
        await admin.auth().deleteUser(uid);
        logger.info(`[createUser] Rolled back auth user: ${uid}`);
        throw new https_1.HttpsError("internal", "Failed to save user profile. The operation was cancelled.");
    }
});
//# sourceMappingURL=createUser.js.map