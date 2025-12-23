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
exports.toggleFollow = void 0;
const https_1 = require("firebase-functions/v2/https");
const admin = __importStar(require("firebase-admin"));
// Ensure Firebase Admin is initialized
if (!admin.apps.length) {
    admin.initializeApp();
}
const db = admin.firestore();
exports.toggleFollow = (0, https_1.onCall)(async (request) => {
    var _a;
    const followerId = (_a = request.auth) === null || _a === void 0 ? void 0 : _a.uid;
    const { targetUserId } = request.data;
    if (!followerId) {
        throw new https_1.HttpsError("unauthenticated", "User must be logged in.");
    }
    if (!targetUserId) {
        throw new https_1.HttpsError("invalid-argument", "Target user ID is required.");
    }
    if (followerId === targetUserId) {
        throw new https_1.HttpsError("invalid-argument", "You cannot follow yourself.");
    }
    const followerRef = db.collection("users").doc(followerId);
    const targetUserRef = db.collection("users").doc(targetUserId);
    // Check if target user exists
    const targetUserSnap = await targetUserRef.get();
    if (!targetUserSnap.exists) {
        throw new https_1.HttpsError("not-found", "User to follow not found.");
    }
    const followingRef = db.collection("following").doc(followerId).collection("userFollowing").doc(targetUserId);
    const followerDocRef = db.collection("followers").doc(targetUserId).collection("userFollowers").doc(followerId);
    try {
        await db.runTransaction(async (transaction) => {
            const followingDoc = await transaction.get(followingRef);
            const isFollowing = followingDoc.exists;
            if (isFollowing) {
                // Unfollow
                transaction.delete(followingRef);
                transaction.delete(followerDocRef);
                // Decrement counts (optional: can be done via triggers for better reliability, but doing it here for speed)
                // Note: Using Cloud Functions triggers for counters is generally safer for consistency.
                // But for this requirement, we'll keep it simple or assume counters are updated via triggers or here.
                // Let's rely on distributed counters or triggers if scalability is huge, but for now, direct update might be okay or just create documents and let triggers handle it.
                // The prompt asked for "Atomic updates".
                // However, updating counts on user documents directly:
                transaction.update(followerRef, {
                    followingCount: admin.firestore.FieldValue.increment(-1)
                });
                transaction.update(targetUserRef, {
                    followersCount: admin.firestore.FieldValue.increment(-1)
                });
            }
            else {
                // Follow
                transaction.set(followingRef, {
                    followedAt: admin.firestore.FieldValue.serverTimestamp()
                });
                transaction.set(followerDocRef, {
                    followedAt: admin.firestore.FieldValue.serverTimestamp()
                });
                transaction.update(followerRef, {
                    followingCount: admin.firestore.FieldValue.increment(1)
                });
                transaction.update(targetUserRef, {
                    followersCount: admin.firestore.FieldValue.increment(1)
                });
            }
        });
        return { success: true };
    }
    catch (error) {
        console.error("Error toggling follow:", error);
        throw new https_1.HttpsError("internal", "Failed to toggle follow status.");
    }
});
//# sourceMappingURL=toggleFollow.js.map