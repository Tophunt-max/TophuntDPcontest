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
exports.deleteUserPost = exports.createPost = void 0;
const https_1 = require("firebase-functions/v2/https");
const admin = __importStar(require("firebase-admin"));
const logger = __importStar(require("firebase-functions/logger"));
const firebase_1 = require("../utils/firebase");
const POST_CONFIG = {
    region: "us-central1",
    cpu: 1, // Increased to 1
    concurrency: 80,
    memory: "256MiB",
    maxInstances: 2,
    cors: true
};
exports.createPost = (0, https_1.onCall)(POST_CONFIG, async (request) => {
    if (!request.auth) {
        throw new https_1.HttpsError("unauthenticated", "User must be logged in.");
    }
    const { mediaUrl, mediaType, caption, location } = request.data;
    if (!mediaUrl || !mediaType) {
        throw new https_1.HttpsError("invalid-argument", "Media URL and type are required.");
    }
    const userId = request.auth.uid;
    try {
        const postRef = firebase_1.db.collection("posts").doc();
        const postData = {
            userId,
            mediaUrl,
            mediaType,
            caption: caption || "",
            location: location || "",
            likesCount: 0,
            commentsCount: 0,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };
        await postRef.set(postData);
        // Update user's post count
        const userRef = firebase_1.db.collection("users").doc(userId);
        await userRef.update({
            postsCount: admin.firestore.FieldValue.increment(1)
        });
        return { success: true, postId: postRef.id };
    }
    catch (error) {
        logger.error("Error creating post record:", error);
        throw new https_1.HttpsError("internal", "Could not create post record.");
    }
});
exports.deleteUserPost = (0, https_1.onCall)(POST_CONFIG, async (request) => {
    var _a, _b, _c;
    if (!request.auth) {
        throw new https_1.HttpsError("unauthenticated", "User must be logged in.");
    }
    const { postId } = request.data;
    if (!postId) {
        throw new https_1.HttpsError("invalid-argument", "Post ID is required.");
    }
    const userId = request.auth.uid;
    try {
        const postRef = firebase_1.db.collection("posts").doc(postId);
        const postDoc = await postRef.get();
        if (!postDoc.exists) {
            throw new https_1.HttpsError("not-found", "Post not found.");
        }
        if (((_a = postDoc.data()) === null || _a === void 0 ? void 0 : _a.userId) !== userId) {
            // Check if user is admin (optional, if we want this function to be used by admins too)
            const userDoc = await firebase_1.db.collection("users").doc(userId).get();
            if (((_b = userDoc.data()) === null || _b === void 0 ? void 0 : _b.role) !== 'admin') {
                throw new https_1.HttpsError("permission-denied", "You don't have permission to delete this post.");
            }
        }
        await postRef.delete();
        // Update user's post count
        const postOwnerId = (_c = postDoc.data()) === null || _c === void 0 ? void 0 : _c.userId;
        const userRef = firebase_1.db.collection("users").doc(postOwnerId);
        await userRef.update({
            postsCount: admin.firestore.FieldValue.increment(-1)
        });
        // Optional: Delete likes and comments associated with this post
        // This could be moved to a background trigger or handled here in a batch
        return { success: true, message: "Post deleted successfully" };
    }
    catch (error) {
        logger.error("Error deleting post:", error);
        if (error instanceof https_1.HttpsError)
            throw error;
        throw new https_1.HttpsError("internal", "Could not delete post.");
    }
});
//# sourceMappingURL=index.js.map