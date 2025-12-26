"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toggleFollow = void 0;
const https_1 = require("firebase-functions/v2/https");
const firestore_1 = require("firebase-admin/firestore");
const firebase_functions_1 = require("firebase-functions");
// Initialize Firestore
const db = (0, firestore_1.getFirestore)();
exports.toggleFollow = (0, https_1.onCall)(async (request) => {
    // 1. Check for authentication
    if (!request.auth) {
        throw new https_1.HttpsError("unauthenticated", "You must be logged in to follow a user.");
    }
    const followerId = request.auth.uid;
    const { targetUserId } = request.data;
    // 2. Validate input
    if (!targetUserId) {
        throw new https_1.HttpsError("invalid-argument", "The function must be called with a 'targetUserId'.");
    }
    if (followerId === targetUserId) {
        throw new https_1.HttpsError("invalid-argument", "You cannot follow yourself.");
    }
    // 3. Create document references
    const followerRef = db.collection("users").doc(followerId);
    const targetRef = db.collection("users").doc(targetUserId);
    try {
        // 4. Run as a transaction to ensure atomicity
        await db.runTransaction(async (transaction) => {
            var _a;
            const followerDoc = await transaction.get(followerRef);
            if (!followerDoc.exists) {
                throw new https_1.HttpsError("not-found", "Your user profile could not be found.");
            }
            const targetDoc = await transaction.get(targetRef);
            if (!targetDoc.exists) {
                throw new https_1.HttpsError("not-found", "The target user profile could not be found.");
            }
            const followerData = followerDoc.data();
            const isCurrentlyFollowing = (_a = followerData === null || followerData === void 0 ? void 0 : followerData.following) === null || _a === void 0 ? void 0 : _a.includes(targetUserId);
            // 5. Perform the follow or unfollow operation
            if (isCurrentlyFollowing) {
                // Unfollow
                transaction.update(followerRef, { following: firestore_1.FieldValue.arrayRemove(targetUserId) });
                transaction.update(targetRef, { followers: firestore_1.FieldValue.arrayRemove(followerId) });
            }
            else {
                // Follow
                transaction.update(followerRef, { following: firestore_1.FieldValue.arrayUnion(targetUserId) });
                transaction.update(targetRef, { followers: firestore_1.FieldValue.arrayUnion(followerId) });
            }
        });
        firebase_functions_1.logger.info(`User ${followerId} successfully updated follow status for ${targetUserId}.`);
        return { success: true, message: "Follow status updated." };
    }
    catch (error) {
        firebase_functions_1.logger.error(`Error in toggleFollow for user ${followerId} and target ${targetUserId}:`, error);
        // Re-throw as an HttpsError to be sent to the client
        if (error instanceof https_1.HttpsError) {
            throw error;
        }
        throw new https_1.HttpsError("internal", "An unexpected error occurred.");
    }
});
//# sourceMappingURL=toggleFollow.js.map