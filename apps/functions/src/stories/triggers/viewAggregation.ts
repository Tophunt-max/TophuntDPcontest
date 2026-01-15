import { onDocumentCreated } from "firebase-functions/v2/firestore";
import * as logger from "firebase-functions/logger";
import { db, admin } from "../../utils/firebase";

/**
 * Aggregates story views asynchronously.
 * Triggered when a new document is created in the storyViews/{storyId}/users/{userId} collection.
 * This ensures that the client-side view event is lightweight and non-blocking.
 * 
 * Performance Note: 
 * We use FieldValue.increment(1) which is atomic and efficient.
 * This runs in the background, keeping the UI thread free.
 */
export const onStoryViewCreated = onDocumentCreated(
    {
        document: "storyViews/{storyId}/users/{userId}",
        region: "us-central1",
        maxInstances: 5, // Allow concurrency for high traffic
        memory: "128MiB" // Lightweight function
    },
    async (event) => {
        const storyId = event.params.storyId;
        // const userId = event.params.userId; // Available if needed for analytics
        const storyRef = db.collection("stories").doc(storyId);

        try {
            // Check if story exists first (optional, but good for data integrity)
            // For max speed, we might skip this if we trust the client logic, 
            // but in a distributed system, it's safer to check or catch the error.
            
            // Increment the viewsCount
            await storyRef.update({
                viewsCount: admin.firestore.FieldValue.increment(1)
            });
            
            // logger.info(`Incremented viewsCount for story: ${storyId} by user ${userId}`);
        } catch (error) {
            // Handle case where story might be deleted while viewing
            logger.warn(`Error incrementing viewsCount for story: ${storyId}`, error);
        }
    }
);
