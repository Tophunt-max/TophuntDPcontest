import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";
import * as logger from "firebase-functions/logger";
import { db } from "../utils/firebase";
import { MemoryOption } from "firebase-functions/v2/options";

const POST_CONFIG = {
    region: "us-central1",
    cpu: 1, // Increased to 1
    concurrency: 80,
    memory: "256MiB" as MemoryOption,
    maxInstances: 2,
    cors: true
};

export const createPost = onCall(POST_CONFIG, async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "User must be logged in.");
    }

    const { mediaUrl, mediaType, caption, location } = request.data;

    if (!mediaUrl || !mediaType) {
        throw new HttpsError("invalid-argument", "Media URL and type are required.");
    }

    const userId = request.auth.uid;

    try {
        const postRef = db.collection("posts").doc();
        const postData = {
            userId,
            mediaUrl,
            mediaType,
            caption: caption || "",
            location: location || "",
            likeCount: 0,
            commentCount: 0,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        await postRef.set(postData);

        // Update user's post count
        const userRef = db.collection("users").doc(userId);
        await userRef.update({
            postsCount: admin.firestore.FieldValue.increment(1)
        });

        return { success: true, postId: postRef.id };
    } catch (error: any) {
        logger.error("Error creating post record:", error);
        throw new HttpsError("internal", "Could not create post record.");
    }
});

export const deleteUserPost = onCall(POST_CONFIG, async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "User must be logged in.");
    }

    const { postId } = request.data;
    if (!postId) {
        throw new HttpsError("invalid-argument", "Post ID is required.");
    }

    const userId = request.auth.uid;

    try {
        const postRef = db.collection("posts").doc(postId);
        const postDoc = await postRef.get();

        if (!postDoc.exists) {
            throw new HttpsError("not-found", "Post not found.");
        }

        if (postDoc.data()?.userId !== userId) {
            // Check if user is admin (optional, if we want this function to be used by admins too)
            const userDoc = await db.collection("users").doc(userId).get();
            if (userDoc.data()?.role !== 'admin') {
                throw new HttpsError("permission-denied", "You don't have permission to delete this post.");
            }
        }

        await postRef.delete();

        // Update user's post count
        const postOwnerId = postDoc.data()?.userId;
        const userRef = db.collection("users").doc(postOwnerId);
        await userRef.update({
            postsCount: admin.firestore.FieldValue.increment(-1)
        });

        // Optional: Delete likes and comments associated with this post
        // This could be moved to a background trigger or handled here in a batch
        
        return { success: true, message: "Post deleted successfully" };
    } catch (error: any) {
        logger.error("Error deleting post:", error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError("internal", "Could not delete post.");
    }
});
