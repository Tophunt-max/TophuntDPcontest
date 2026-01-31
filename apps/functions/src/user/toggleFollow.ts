import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { createNotification } from "../notifications/utils"; 
import { MemoryOption } from "firebase-functions/v2/options";

// Initialize Firestore
const db = getFirestore();

const FOLLOW_CONFIG = {
    region: "us-central1",
    cpu: 1,
    concurrency: 80,
    memory: "256MiB" as MemoryOption,
    maxInstances: 2,
    cors: true
};

export const toggleFollow = onCall(FOLLOW_CONFIG, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "You must be logged in to follow a user.");
  }

  const followerId = request.auth.uid;
  const { targetUserId } = request.data;

  if (!targetUserId) {
    throw new HttpsError("invalid-argument", "The function must be called with a 'targetUserId'.");
  }

  if (followerId === targetUserId) {
    throw new HttpsError("invalid-argument", "You cannot follow yourself.");
  }

  const followerRef = db.collection("users").doc(followerId);
  const targetRef = db.collection("users").doc(targetUserId);

  let isFollowing = false;
  let followerName = "Someone";
  let followerAvatar = "";

  try {
    const result = await db.runTransaction(async (transaction) => {
      const followerDoc = await transaction.get(followerRef);
      const targetDoc = await transaction.get(targetRef);

      if (!followerDoc.exists || !targetDoc.exists) {
        throw new HttpsError("not-found", "User profile not found.");
      }

      const followerData = followerDoc.data();
      const targetData = targetDoc.data();
      
      followerName = followerData?.username || followerData?.fullName || "Someone";
      followerAvatar = followerData?.profileImageUrl || "";
      
      const isCurrentlyFollowing = followerData?.following?.includes(targetUserId);

      if (isCurrentlyFollowing) {
        // Unfollow logic
        transaction.update(followerRef, { 
            following: FieldValue.arrayRemove(targetUserId),
            "stats.followingCount": FieldValue.increment(-1)
        });
        transaction.update(targetRef, { 
            "stats.followersCount": FieldValue.increment(-1) 
        });
        isFollowing = false;
      } else {
        // Follow logic
        transaction.update(followerRef, { 
            following: FieldValue.arrayUnion(targetUserId),
            "stats.followingCount": FieldValue.increment(1)
        });
        transaction.update(targetRef, { 
            "stats.followersCount": FieldValue.increment(1) 
        });
        isFollowing = true;
      }
      return { isFollowing };
    });

    isFollowing = result.isFollowing;

    // Send Notification only on Follow
    if (isFollowing) {
      await createNotification(
        targetUserId,
        {
            title: "New Follower! 👤",
            body: `${followerName} started following you.`,
            type: "follow",
            targetId: followerId, // Clicking notif goes to follower profile
            image: followerAvatar
        }
      );
    }

    return { success: true, isFollowing };

  } catch (error: any) {
    logger.error("Error in toggleFollow:", error);
    if (error instanceof HttpsError) throw error;
    throw new HttpsError("internal", error.message || "An unexpected error occurred.");
  }
});
