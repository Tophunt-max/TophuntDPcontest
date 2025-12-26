import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { logger } from "firebase-functions";

// Initialize Firestore
const db = getFirestore();

export const toggleFollow = onCall(async (request) => {
  // 1. Check for authentication
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "You must be logged in to follow a user.");
  }

  const followerId = request.auth.uid;
  const { targetUserId } = request.data;

  // 2. Validate input
  if (!targetUserId) {
    throw new HttpsError("invalid-argument", "The function must be called with a 'targetUserId'.");
  }

  if (followerId === targetUserId) {
    throw new HttpsError("invalid-argument", "You cannot follow yourself.");
  }

  // 3. Create document references
  const followerRef = db.collection("users").doc(followerId);
  const targetRef = db.collection("users").doc(targetUserId);

  try {
    // 4. Run as a transaction to ensure atomicity
    await db.runTransaction(async (transaction) => {
      const followerDoc = await transaction.get(followerRef);

      if (!followerDoc.exists) {
        throw new HttpsError("not-found", "Your user profile could not be found.");
      }
      
      const targetDoc = await transaction.get(targetRef);

      if (!targetDoc.exists) {
        throw new HttpsError("not-found", "The target user profile could not be found.");
      }

      const followerData = followerDoc.data();
      const isCurrentlyFollowing = followerData?.following?.includes(targetUserId);

      // 5. Perform the follow or unfollow operation
      if (isCurrentlyFollowing) {
        // Unfollow
        transaction.update(followerRef, { following: FieldValue.arrayRemove(targetUserId) });
        transaction.update(targetRef, { followers: FieldValue.arrayRemove(followerId) });
      } else {
        // Follow
        transaction.update(followerRef, { following: FieldValue.arrayUnion(targetUserId) });
        transaction.update(targetRef, { followers: FieldValue.arrayUnion(followerId) });
      }
    });

    logger.info(`User ${followerId} successfully updated follow status for ${targetUserId}.`);
    return { success: true, message: "Follow status updated." };

  } catch (error) {
    logger.error(`Error in toggleFollow for user ${followerId} and target ${targetUserId}:`, error);
    // Re-throw as an HttpsError to be sent to the client
    if (error instanceof HttpsError) {
      throw error;
    }
    throw new HttpsError("internal", "An unexpected error occurred.");
  }
});
