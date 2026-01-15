import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import { db } from "../utils/firebase";
import * as logger from "firebase-functions/logger";

/**
 * Triggered when a user profile is updated.
 * Syncs the new profile picture (Cloudflare optimized) and display name everywhere.
 */
export const syncUserProfileUpdates = onDocumentUpdated(
  "users/{userId}",
  async (event) => {
    const newData = event.data?.after.data();
    const oldData = event.data?.before.data();
    const userId = event.params.userId;

    if (!newData || !oldData) return;

    // Detect changes
    const photoChanged = newData.profileImageUrl !== oldData.profileImageUrl;
    const nameChanged = newData.fullName !== oldData.fullName || newData.username !== oldData.username;

    if (!photoChanged && !nameChanged) return;

    const updates: Promise<any>[] = [];
    const newAvatar = newData.profileImageUrl || newData.photoURL || "";
    const newName = newData.fullName || newData.displayName || newData.username || "User";

    logger.info(`[Sync] Updating profile for ${userId} to: ${newAvatar}`);

    // 1. Update Comments across ALL posts (Collection Group)
    // NOTE: This requires a Firestore index. If index is missing, this will log an error.
    try {
      const commentsSnapshot = await db.collectionGroup('comments')
        .where('userId', '==', userId)
        .get();

      if (!commentsSnapshot.empty) {
        const batch = db.batch();
        commentsSnapshot.docs.forEach((doc) => {
          batch.update(doc.ref, {
            userAvatar: newAvatar, // Updated to match your CommentSheet field
            username: newName
          });
        });
        updates.push(batch.commit());
        logger.info(`[Sync] Queued ${commentsSnapshot.size} comment updates`);
      }
    } catch (error) {
      logger.error("[Sync] Error syncing comments (Index might be missing)", error);
    }

    // 2. Update Stories
    try {
      const storiesSnapshot = await db.collection('stories')
        .where('userId', '==', userId)
        .get();

      if (!storiesSnapshot.empty) {
        const batch = db.batch();
        storiesSnapshot.docs.forEach((doc) => {
          batch.update(doc.ref, {
            avatarUrl: newAvatar,
            username: newName
          });
        });
        updates.push(batch.commit());
      }
    } catch (error) {
      logger.error("[Sync] Error syncing stories", error);
    }
    
    // 3. Update Contest Matches
    try {
        const matchesASnapshot = await db.collection('contestMatches').where('userA.uid', '==', userId).get();
        if (!matchesASnapshot.empty) {
            const batch = db.batch();
            matchesASnapshot.docs.forEach(doc => {
                batch.update(doc.ref, {
                    'userA.profilePic': newAvatar,
                    'userA.username': newName
                });
            });
            updates.push(batch.commit());
        }

        const matchesBSnapshot = await db.collection('contestMatches').where('userB.uid', '==', userId).get();
        if (!matchesBSnapshot.empty) {
            const batch = db.batch();
            matchesBSnapshot.docs.forEach(doc => {
                batch.update(doc.ref, {
                    'userB.profilePic': newAvatar,
                    'userB.username': newName
                });
            });
            updates.push(batch.commit());
        }
    } catch (error) {
        logger.error("[Sync] Error syncing matches", error);
    }

    await Promise.all(updates);
    logger.info(`[Sync] Completed successfully for user: ${userId}`);
  }
);
