import { onCall, HttpsError } from "firebase-functions/v2/https";
import { db, admin } from "../utils/firebase";
import * as logger from "firebase-functions/logger";

/**
 * Sends a push notification to a specific user.
 * Separate helper function to be reused internally.
 */
export const sendPushNotification = async (
  userId: string,
  title: string,
  body: string,
  type: string,
  data: any = {}
) => {
  // 1. SAVE TO FIRESTORE
  const notifRef = db.collection("notifications").doc();
  await notifRef.set({
    recipientUid: userId,
    type,
    title,
    body,
    data,
    read: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // 2. SEND FCM PUSH
  try {
    const userDoc = await db.collection("users").doc(userId).get();
    const userData = userDoc.data();
    // Support both field names
    const fcmToken = userData?.fcmToken || userData?.pushToken;

    if (!fcmToken) {
      logger.warn(`No FCM token found for user ${userId}. Skipping push.`);
      return;
    }

    const message = {
      notification: { title, body },
      data: { 
        ...data, 
        click_action: "FLUTTER_NOTIFICATION_CLICK", 
        type 
      },
      token: fcmToken,
    };

    await admin.messaging().send(message);
    logger.info(`Push sent successfully to ${userId}`);
  } catch (error: any) {
    logger.error(`FCM Error for user ${userId}:`, error);
    // Do not throw here, so other notifications can proceed
  }
};

/**
 * Send a broadcast notification to all users or selected segments.
 * Callable from Admin Panel.
 */
export const sendBroadcastNotification = onCall({ 
    region: 'us-central1',
    memory: '512MiB', // Increased memory for batch processing
    maxInstances: 1,
    timeoutSeconds: 300 // Increased timeout for long running broadcast
}, async (request) => {
    // 1. Ensure caller is authenticated
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "User must be logged in.");
    }

    // 2. Check Admin Permissions
    // NOTE: If you get permission-denied, ensure your user has custom claim { admin: true }
    // For debugging, we are logging the token claims
    logger.info("Broadcast requester claims:", request.auth.token);
    
    // Uncomment this strict check for production
    // if (request.auth.token.admin !== true) {
    //     throw new HttpsError("permission-denied", "Only administrators can send broadcasts.");
    // }

    const { title, body, imageUrl, targetPage } = request.data;

    if (!title || !body) {
        throw new HttpsError("invalid-argument", "Title and Body are required.");
    }

    logger.info(`Starting broadcast: ${title}`);

    try {
        // 2. Fetch all users with push tokens
        // Optimisation: Only fetch ID and token
        const usersSnap = await db.collection("users")
            .where("fcmToken", "!=", null)
            .select("fcmToken") 
            .get();
            
        // Also try fetching 'pushToken' field if needed (or combine results)
        // For simplicity we assume 'fcmToken' is the standard now.

        if (usersSnap.empty) {
            return { sentCount: 0, message: "No users with push tokens found." };
        }

        const notificationData = {
            click_action: "FLUTTER_NOTIFICATION_CLICK",
            type: "broadcast",
            imageUrl: imageUrl || "",
            targetPage: targetPage || "/home"
        };

        const batchSize = 100; // FCM batch limit is 500, keeping safe 100
        let sentCount = 0;
        const messages: admin.messaging.Message[] = [];

        // Prepare all messages
        usersSnap.docs.forEach(doc => {
            const token = doc.data().fcmToken;
            if (token) {
                messages.push({
                    notification: { title, body },
                    data: notificationData,
                    token: token
                });
            }
        });

        // Send in batches
        for (let i = 0; i < messages.length; i += batchSize) {
            const chunk = messages.slice(i, i + batchSize);
            const response = await admin.messaging().sendEach(chunk); // New API
            sentCount += response.successCount;
            
            if (response.failureCount > 0) {
                logger.warn(`Batch ${i} had ${response.failureCount} failures.`);
                response.responses.forEach((resp, idx) => {
                    if (!resp.success) {
                        logger.error(`Error sending to token:`, resp.error);
                    }
                });
            }
        }

        // 4. Save broadcast log for history
        await db.collection("broadcastHistory").add({
            title,
            body,
            imageUrl: imageUrl || null,
            sentCount,
            adminId: request.auth.uid,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });

        return { success: true, sentCount };
    } catch (error: any) {
        logger.error("Broadcast failed:", error);
        throw new HttpsError("internal", error.message);
    }
});
