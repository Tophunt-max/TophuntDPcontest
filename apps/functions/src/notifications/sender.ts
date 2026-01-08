import * as admin from "firebase-admin";
import { db } from "../utils/firebase";

export const sendPushNotification = async (
  userId: string,
  title: string,
  body: string,
  type: string,
  data: Record<string, string> = {}
) => {
  try {
    const userDoc = await db.collection("users").doc(userId).get();
    if (!userDoc.exists) return;

    const userData = userDoc.data();
    // Support both array and map for tokens, prioritizing array for now
    const tokens: string[] = userData?.fcmTokens || [];

    if (!tokens.length) return;

    const message: admin.messaging.MulticastMessage = {
      tokens: tokens,
      notification: {
        title,
        body,
      },
      data: {
        type,
        ...data,
      },
      android: {
        notification: {
          icon: "ic_notification",
          color: "#FF4D67",
        },
      },
      webpush: {
        headers: {
          Urgency: "high",
        },
        notification: {
          icon: "/icons/icon-192x192.png",
          badge: "/icons/badge-72x72.png",
        },
        fcmOptions: {
          link: data.url || "/",
        }
      },
      apns: {
        payload: {
          aps: {
            alert: {
              title,
              body,
            },
            badge: 1,
            sound: "default",
          },
        },
      },
    };

    const response = await admin.messaging().sendEachForMulticast(message);
    
    if (response.failureCount > 0) {
      const failedTokens: string[] = [];
      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
            // @ts-ignore: errorInfo exists on failure
            const error = resp.error;
            if (error?.code === 'messaging/invalid-registration-token' ||
                error?.code === 'messaging/registration-token-not-registered') {
                failedTokens.push(tokens[idx]);
            }
        }
      });
      
      if (failedTokens.length > 0) {
        await db.collection("users").doc(userId).update({
          fcmTokens: admin.firestore.FieldValue.arrayRemove(...failedTokens)
        });
      }
    }
  } catch (error) {
    console.error("Error sending push notification:", error);
  }
};

export const sendBroadcastNotification = async (
    title: string,
    body: string,
    data: Record<string, string> = {}
) => {
    // This is a heavy operation. For production, consider using Topic Messaging or Batched processing.
    // For this implementation, we will use topic 'all_users' if clients subscribe to it,
    // OR fetch all users with tokens (expensive).
    // Requirement says "Secure Admin Notification System".
    // Best practice: Send to a topic "all_users".
    
    const message: admin.messaging.Message = {
        topic: 'all_users',
        notification: {
            title,
            body
        },
        data: {
            type: 'admin',
            ...data
        },
        android: {
            notification: {
              icon: "ic_notification",
              color: "#FF4D67",
            },
        },
        webpush: {
            notification: {
              icon: "/icons/icon-192x192.png",
            }
        }
    };

    try {
        await admin.messaging().send(message);
    } catch (error) {
        console.error("Error sending broadcast:", error);
        // Fallback or detailed error handling
    }
};
