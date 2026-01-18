import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";
import { db } from "../utils/firebase";

/**
 * UNIFIED ADMIN HANDLER
 * Consolidates all admin actions into a single protected entry point.
 */
export const adminHandler = onCall({
    region: "us-central1",
    memory: "256MiB",
    maxInstances: 5, // Admin tasks are infrequent
    cors: true
}, async (request) => {
    // 1. Authentication Check
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "Authentication required.");
    }

    const callerUid = request.auth.uid;

    // 2. Authorization Check (Is Caller an Admin or Moderator?)
    const callerDoc = await db.collection("users").doc(callerUid).get();
    const callerRole = callerDoc.data()?.role;

    if (!callerDoc.exists || (callerRole !== "admin" && callerRole !== "moderator")) {
        throw new HttpsError("permission-denied", "Only admins or moderators can perform this action.");
    }

    const { action, data } = request.data;
    if (!action) throw new HttpsError("invalid-argument", "Action is required.");

    try {
        switch (action) {
            case "setRole": {
                const { uid, role } = data;
                if (!uid || !role) throw new HttpsError("invalid-argument", "UID and role are required.");
                
                // Set custom claims (for security) and update Firestore (for UI)
                await admin.auth().setCustomUserClaims(uid, { role });
                await db.collection("users").doc(uid).update({ role });
                
                return { message: `Successfully set role ${role} for user ${uid}` };
            }

            case "deletePost": {
                const { postId } = data;
                if (!postId) throw new HttpsError("invalid-argument", "PostID is required.");
                
                await db.collection("posts").doc(postId).delete();
                // Optionally delete associated media if needed
                
                return { message: `Post ${postId} deleted successfully.` };
            }

            case "unblockUser": {
                const { uid } = data;
                if (!uid) throw new HttpsError("invalid-argument", "UID is required.");
                
                await db.collection("users").doc(uid).update({
                    status: "active",
                    blocked: false
                });
                
                return { message: `User ${uid} has been unblocked.` };
            }

            case "manageWallet": {
                const { uid, amount, transactionType, reason } = data;
                if (!uid || amount === undefined) throw new HttpsError("invalid-argument", "Missing data.");
                
                const userRef = db.collection("users").doc(uid);
                await userRef.update({
                    Dpcoin: admin.firestore.FieldValue.increment(transactionType === 'decrement' ? -amount : amount)
                });

                // Log the admin transaction
                await db.collection("coin_transactions").add({
                    userId: uid,
                    amount,
                    type: transactionType === 'decrement' ? 'admin_deduction' : 'admin_credit',
                    reason: reason || "Admin Adjustment",
                    timestamp: admin.firestore.FieldValue.serverTimestamp()
                });

                return { message: "Wallet adjusted successfully." };
            }

            case "deleteStory": {
                const { storyId } = data;
                if (!storyId) throw new HttpsError("invalid-argument", "StoryID is required.");
                await db.collection("stories").doc(storyId).delete();
                return { message: `Story ${storyId} deleted.` };
            }

            default:
                throw new HttpsError("invalid-argument", `Unknown action: ${action}`);
        }
    } catch (error: any) {
        console.error("Admin Handler Error:", error);
        throw new HttpsError("internal", error.message || "Admin action failed.");
    }
});
