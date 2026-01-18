import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { db, admin } from "../utils/firebase";
import { Timestamp } from "firebase-admin/firestore";

/**
 * UNIFIED STORY HANDLER
 * Action: create | view | delete
 * This handles all story life-cycle events in one scalable function.
 */
export const storyHandler = onCall({
    region: "us-central1",
    memory: "256MiB",
    maxInstances: 10, // Optimized for quota limits
    timeoutSeconds: 60,
    cors: true,
}, async (request) => {
    const { action } = request.data;
    const uid = request.auth?.uid;

    if (!uid) throw new HttpsError("unauthenticated", "User must be logged in.");
    if (!action) throw new HttpsError("invalid-argument", "Action is required.");

    switch (action) {
        case "create": {
            const { mediaUrl, type, storyId, objectKey, overlayText, textPosition, mentions } = request.data;
            
            if (!mediaUrl || !type) {
                throw new HttpsError("invalid-argument", "Media data is missing.");
            }

            try {
                const userDoc = await db.collection("users").doc(uid).get();
                if (!userDoc.exists) throw new HttpsError("not-found", "User profile not found.");
                const userData = userDoc.data();

                const storyData = {
                    userId: uid,
                    username: userData?.username || "Unknown",
                    avatarUrl: userData?.profileImageUrl || null,
                    mediaUrl,
                    objectKey: objectKey || null,
                    mediaType: (type === 'status_video' || type === 'video') ? 'video' : 'image',
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    expiresAt: Timestamp.fromMillis(Date.now() + 24 * 60 * 60 * 1000), // 24H Expiry
                    viewsCount: 0,
                    overlayText: overlayText || null,
                    textPosition: textPosition || null,
                    mentions: mentions || []
                };

                const finalId = storyId || db.collection("stories").doc().id;
                await db.collection("stories").doc(finalId).set(storyData);
                
                return { success: true, storyId: finalId };
            } catch (error) {
                logger.error("Error creating story:", error);
                throw new HttpsError("internal", "Failed to create story record.");
            }
        }

        case "view": {
            const { storyId } = request.data;
            if (!storyId) throw new HttpsError("invalid-argument", "storyId is required.");
            
            try {
                // 1. Log view record (Sub-collection)
                const viewRef = db.collection("stories").doc(storyId).collection("views").doc(uid);
                await viewRef.set({
                    viewerId: uid,
                    viewedAt: admin.firestore.FieldValue.serverTimestamp()
                });

                // 2. Increment Counter Atomically
                await db.collection("stories").doc(storyId).update({
                    viewsCount: admin.firestore.FieldValue.increment(1)
                });
                
                return { success: true };
            } catch (e) { 
                logger.error("View log failed", e);
                return { success: false }; 
            }
        }

        case "delete": {
            const { storyId } = request.data;
            if (!storyId) throw new HttpsError("invalid-argument", "storyId is required.");

            try {
                const storyRef = db.collection("stories").doc(storyId);
                const doc = await storyRef.get();
                if (!doc.exists) throw new HttpsError("not-found", "Story not found.");
                
                // Permission check: Owner or Admin
                if (doc.data()?.userId !== uid) {
                    const adminDoc = await db.collection("admins").doc(uid).get();
                    if (!adminDoc.exists) throw new HttpsError("permission-denied", "Access denied.");
                }

                await storyRef.delete();
                return { success: true };
            } catch (error) {
                throw new HttpsError("internal", "Deletion failed.");
            }
        }

        default:
            throw new HttpsError("invalid-argument", `Invalid action: ${action}`);
    }
});
