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
exports.authHandler = void 0;
const https_1 = require("firebase-functions/v2/https");
const admin = __importStar(require("firebase-admin"));
const logger = __importStar(require("firebase-functions/logger"));
const firebase_1 = require("../utils/firebase");
// CPU must be >= 1 for concurrency
const AUTH_CONFIG = {
    region: "us-central1",
    cpu: 1,
    concurrency: 80, // Can handle many requests
    minInstances: 0,
    maxInstances: 2,
    memory: "256MiB",
    timeoutSeconds: 60,
    cors: true,
};
exports.authHandler = (0, https_1.onCall)(AUTH_CONFIG, async (request) => {
    var _a, _b;
    // 1. Basic validation
    if (!request.data || !request.data.action) {
        throw new https_1.HttpsError("invalid-argument", "Request must specify an 'action' ('check', 'create', 'createProfile').");
    }
    const { action, type } = request.data;
    // ---------------------------------------------------------
    // ACTION: CHECK (email, phone, username)
    // ---------------------------------------------------------
    if (action === "check") {
        if (!type || !["email", "phone", "username"].includes(type)) {
            throw new https_1.HttpsError("invalid-argument", "For check action, 'type' must be 'email', 'phone', or 'username'.");
        }
        const value = (_a = request.data.value) === null || _a === void 0 ? void 0 : _a.trim();
        if (!value) {
            throw new https_1.HttpsError("invalid-argument", `Missing value for check type: ${type}`);
        }
        logger.info(`[authHandler] Checking ${type}: ${value}`);
        try {
            const snapshot = await firebase_1.db
                .collection("users")
                .where(type, "==", value)
                .limit(1)
                .get();
            const exists = !snapshot.empty;
            return { exists };
        }
        catch (error) {
            logger.error(`[authHandler] Check failed for ${type}:`, error);
            throw new https_1.HttpsError("internal", "Database error while checking uniqueness.");
        }
    }
    // ---------------------------------------------------------
    // ACTION: CREATE USER (Auth + Profile)
    // ---------------------------------------------------------
    if (action === "create") {
        const { email, password, username, fullName, avatarUrl, dob, phone, occupation, gender, following, platform, } = request.data;
        if (!email || !password || !username) {
            throw new https_1.HttpsError("invalid-argument", "Email, password, and username are required for user creation.");
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
        }
        catch (error) {
            if (error.code === "auth/email-already-exists") {
                throw new https_1.HttpsError("already-exists", "This email is already registered.");
            }
            logger.error("[authHandler] Auth creation failed:", error);
            throw new https_1.HttpsError("internal", "Could not create user account.");
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
        }
        catch (error) {
            logger.error(`[authHandler] Firestore creation failed for ${uid}. Rolling back auth.`, error);
            // Rollback Auth User if Firestore fails
            await admin.auth().deleteUser(uid).catch(() => { });
            throw new https_1.HttpsError("internal", "Failed to save user profile. Account creation cancelled.");
        }
    }
    // ---------------------------------------------------------
    // ACTION: CREATE PROFILE (Firestore Only - for Social Auth)
    // ---------------------------------------------------------
    if (action === "createProfile") {
        const uid = ((_b = request.auth) === null || _b === void 0 ? void 0 : _b.uid) || request.data.uid;
        if (!uid) {
            throw new https_1.HttpsError("unauthenticated", "User must be authenticated or provide UID.");
        }
        const { email, username, fullName, avatarUrl, dob, phone, occupation, gender, following, platform, } = request.data;
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
        }
        catch (error) {
            logger.error("[authHandler] Error creating user profile:", error);
            throw new https_1.HttpsError("internal", "Could not create user record.");
        }
    }
    // ---------------------------------------------------------
    // INVALID ACTION
    // ---------------------------------------------------------
    throw new https_1.HttpsError("invalid-argument", `Unknown action: ${action}`);
});
// Helper function to keep code DRY
async function createFirestoreProfile(uid, data) {
    const userRef = firebase_1.db.collection("users").doc(uid);
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
//# sourceMappingURL=authHandler.js.map