import { db } from "../utils/firebase";
import { FieldValue } from "firebase-admin/firestore";
import { sendPushNotification } from "./sender";

export const createNotification = async (
  recipientId: string,
  notification: {
    title: string;
    body: string;
    type: "like" | "comment" | "follow" | "contest" | "admin";
    targetId: string;
    image?: string;
    data?: Record<string, string>;
  }
) => {
  if (!recipientId) return;

  try {
      // Create Firestore Notification
      await db.collection("notifications").doc(recipientId).collection("items").add({
        ...notification,
        read: false,
        createdAt: FieldValue.serverTimestamp(),
      });

      // Send Push
      await sendPushNotification(
        recipientId,
        notification.title,
        notification.body,
        notification.type,
        { 
            targetId: notification.targetId, 
            image: notification.image || "",
            click_action: "FLUTTER_NOTIFICATION_CLICK",
            ...(notification.data || {})
        }
      );
  } catch (e) {
      console.error("Error creating notification", e);
  }
};

export const sendBroadcastToAllUsers = async (
    title: string,
    body: string,
    imageUrl?: string,
    data?: Record<string, string>
) => {
    let sentCount = 0;
    try {
        const usersSnapshot = await db.collection("users").get();
        
        // Parallel execution for better performance
        const promises = usersSnapshot.docs.map(async (doc) => {
            const userId = doc.id;
            // Skip users without tokens if optimization needed, but createNotification handles checks
            await createNotification(userId, {
                title,
                body,
                type: "admin",
                targetId: "broadcast",
                image: imageUrl,
                data
            });
            return true;
        });

        const results = await Promise.all(promises);
        sentCount = results.length;
    } catch (error) {
        console.error("Error in broadcast:", error);
    }
    return sentCount;
};
