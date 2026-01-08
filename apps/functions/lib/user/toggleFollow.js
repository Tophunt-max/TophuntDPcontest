"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toggleFollow = void 0;
const https_1 = require("firebase-functions/v2/https");
const firestore_1 = require("firebase-admin/firestore");
const firebase_functions_1 = require("firebase-functions");
const utils_1 = require("../notifications/utils");
// Initialize Firestore
const db = (0, firestore_1.getFirestore)();
const FOLLOW_CONFIG = {
    region: "us-central1",
    cpu: 1,
    concurrency: 80,
    memory: "256MiB",
    maxInstances: 2,
    cors: true
};
exports.toggleFollow = (0, https_1.onCall)(FOLLOW_CONFIG, async (request) => {
    if (!request.auth) {
        throw new https_1.HttpsError("unauthenticated", "You must be logged in to follow a user.");
    }
    const followerId = request.auth.uid;
    const { targetUserId } = request.data;
    if (!targetUserId) {
        throw new https_1.HttpsError("invalid-argument", "The function must be called with a 'targetUserId'.");
    }
    if (followerId === targetUserId) {
        throw new https_1.HttpsError("invalid-argument", "You cannot follow yourself.");
    }
    const followerRef = db.collection("users").doc(followerId);
    const targetRef = db.collection("users").doc(targetUserId);
    let isFollowing = false;
    let followerName = "Someone";
    let followerAvatar = "";
    try {
        await db.runTransaction(async (transaction) => {
            var _a;
            const followerDoc = await transaction.get(followerRef);
            const targetDoc = await transaction.get(targetRef);
            if (!followerDoc.exists || !targetDoc.exists) {
                throw new https_1.HttpsError("not-found", "User profile not found.");
            }
            const followerData = followerDoc.data();
            followerName = (followerData === null || followerData === void 0 ? void 0 : followerData.username) || (followerData === null || followerData === void 0 ? void 0 : followerData.fullName) || "Someone";
            followerAvatar = (followerData === null || followerData === void 0 ? void 0 : followerData.profileImageUrl) || "";
            const isCurrentlyFollowing = (_a = followerData === null || followerData === void 0 ? void 0 : followerData.following) === null || _a === void 0 ? void 0 : _a.includes(targetUserId);
            if (isCurrentlyFollowing) {
                // Unfollow logic
                transaction.update(followerRef, { following: firestore_1.FieldValue.arrayRemove(targetUserId) });
                transaction.update(targetRef, { followers: firestore_1.FieldValue.arrayRemove(followerId) });
                transaction.update(targetRef, { followersCount: firestore_1.FieldValue.increment(-1) });
                transaction.update(followerRef, { followingCount: firestore_1.FieldValue.increment(-1) });
                isFollowing = false;
            }
            else {
                // Follow logic
                transaction.update(followerRef, { following: firestore_1.FieldValue.arrayUnion(targetUserId) });
                transaction.update(targetRef, { followers: firestore_1.FieldValue.arrayUnion(followerId) });
                transaction.update(targetRef, { followersCount: firestore_1.FieldValue.increment(1) });
                transaction.update(followerRef, { followingCount: firestore_1.FieldValue.increment(1) });
                isFollowing = true;
            }
        });
        // Send Notification only on Follow
        if (isFollowing) {
            await (0, utils_1.createNotification)(targetUserId, {
                title: "New Follower! 👤",
                body: `${followerName} started following you.`,
                type: "follow",
                targetId: followerId, // Clicking notif goes to follower profile
                image: followerAvatar
            });
        }
        return { success: true, isFollowing };
    }
    catch (error) {
        firebase_functions_1.logger.error("Error in toggleFollow:", error);
        if (error instanceof https_1.HttpsError)
            throw error;
        throw new https_1.HttpsError("internal", "An unexpected error occurred.");
    }
});
//# sourceMappingURL=toggleFollow.js.map