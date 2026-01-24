import { db } from "../utils/firebase";
import { FieldValue } from "firebase-admin/firestore";
import { sendPushNotification, sendBroadcastNotification } from "./sender";

export type NotificationType = 
    | "like" 
    | "comment" 
    | "follow" 
    | "contest" 
    | "admin"
    | "system"
    | "reply"
    | "comment-like"
    | "contest-invite"
    | "contest-start"
    | "contest-watch"
    | "contest-win"
    | "contest-end"
    | "contest-ending"
    | "contest-loss"
    | "contest-refund"
    | "contest-tie"
    | "hall-of-fame"
    | "wallet"
    | "milestone"
    | "share"
    | "profile-visit"
    | "level-up";

export const createNotification = async (
  recipientId: string,
  notification: {
    title: string;
    body: string;
    type: NotificationType;
    targetId: string;
    image?: string;
    data?: Record<string, string>;
  }
) => {
  if (!recipientId) return;

  try {
      // 1. Create Firestore Notification Item
      const notificationRef = db.collection("notifications").doc(recipientId).collection("items").doc();
      
      const batch = db.batch();
      batch.set(notificationRef, {
        ...notification,
        id: notificationRef.id,
        read: false,
        createdAt: FieldValue.serverTimestamp(),
      });

      // 2. Increment Unread Counter (Production Grade Experience)
      const userRef = db.collection("users").doc(recipientId);
      batch.update(userRef, {
        unreadNotificationsCount: FieldValue.increment(1),
        updatedAt: FieldValue.serverTimestamp()
      });

      await batch.commit();

      // 3. Send Push Notification
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

/**
 * PRODUCTION BROADCAST: Using FCM Topics for infinite scalability.
 */
export const sendBroadcastToAllUsers = async (
    title: string,
    body: string,
    imageUrl?: string,
    data?: Record<string, string>
) => {
    try {
        // For production, we use the Topic system because looping through all users
        // is slow and expensive (O(N) vs O(1) FCM request).
        await sendBroadcastNotification(title, body, {
            ...data,
            image: imageUrl || "",
            targetId: "broadcast"
        });
        
        // Note: Broadcasts to Topics don't usually create individual Firestore notifications
        // because it would be too many writes. If you NEED it in their "In-App" Inbox,
        // it's better to show a separate "Global Announcements" section.
        
        return true;
    } catch (error) {
        console.error("Error in broadcast:", error);
        return false;
    }
};
