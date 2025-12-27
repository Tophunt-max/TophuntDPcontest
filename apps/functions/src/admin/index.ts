import { onCall, HttpsError } from "firebase-functions/v2/https";
import { auth, db } from "../utils/firebase";

export const setAdminRole = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError(
      "unauthenticated",
      "The function must be called while authenticated."
    );
  }

  const callerUid = request.auth.uid;
  const callerDoc = await db.collection("users").doc(callerUid).get();
  if (!callerDoc.exists || callerDoc.data()?.role !== "admin") {
     throw new HttpsError(
       "permission-denied",
       "Only admins can set admin roles."
     );
  }

  const { uid } = request.data;

  if (!uid) {
    throw new HttpsError("invalid-argument", "The function must be called with a 'uid'.");
  }

  try {
    await auth.setCustomUserClaims(uid, { role: "admin" });
    await db.collection("users").doc(uid).update({
      role: "admin",
    });

    return { message: `Successfully set admin role for user ${uid}` };
  } catch (error) {
    console.error("Error setting admin role:", error);
    throw new HttpsError("internal", "An error occurred while setting the admin role.");
  }
});

export const deletePost = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError(
      "unauthenticated",
      "The function must be called while authenticated."
    );
  }

  // Check if the requester is an admin or moderator
  const callerUid = request.auth.uid;
  const callerDoc = await db.collection("users").doc(callerUid).get();
  const callerRole = callerDoc.data()?.role;

  if (!callerDoc.exists || (callerRole !== "admin" && callerRole !== "moderator")) {
     throw new HttpsError(
       "permission-denied",
       "Only admins or moderators can delete posts."
     );
  }

  const { postId } = request.data;

  if (!postId) {
    throw new HttpsError("invalid-argument", "The function must be called with a 'postId'.");
  }

  try {
    await db.collection("posts").doc(postId).delete();
    // In a real app, you'd also delete the image from S3/Storage here
    return { message: `Successfully deleted post ${postId}` };
  } catch (error) {
    console.error("Error deleting post:", error);
    throw new HttpsError("internal", "An error occurred while deleting the post.");
  }
});

export const unblockUser = onCall(async (request) => {
    if (!request.auth) {
      throw new HttpsError(
        "unauthenticated",
        "The function must be called while authenticated."
      );
    }
  
    const callerUid = request.auth.uid;
    const callerDoc = await db.collection("users").doc(callerUid).get();
    if (!callerDoc.exists || callerDoc.data()?.role !== "admin") {
       throw new HttpsError(
         "permission-denied",
         "Only admins can unblock users."
       );
    }
  
    const { uid } = request.data;
  
    if (!uid) {
      throw new HttpsError("invalid-argument", "The function must be called with a 'uid'.");
    }
  
    try {
      await db.collection("users").doc(uid).update({
        status: "active", // or whatever field you use to block
        blocked: false
      });
  
      return { message: `Successfully unblocked user ${uid}` };
    } catch (error) {
      console.error("Error unblocking user:", error);
      throw new HttpsError("internal", "An error occurred while unblocking the user.");
    }
  });
