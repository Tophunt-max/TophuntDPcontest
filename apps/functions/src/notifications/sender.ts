import { db, admin } from "../utils/firebase";

/**
 * Sends a push notification via FCM and saves it to Firestore.
 */
export const sendPushNotification = async (
  userId: string,
  title: string,
  body: string,
  type: string,
  data: any = {}
) => {
  // 1. SAVE TO FIRESTORE (Global notifications collection or User sub-collection)
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
  const userDoc = await db.collection("users").doc(userId).get();
  const fcmToken = userDoc.data()?.fcmToken || userDoc.data()?.pushToken;

  if (!fcmToken) {
    console.log(`No FCM token found for user ${userId}`);
    return;
  }

  const message = {
    notification: { title, body },
    data: { 
      ...data, 
      click_action: "FLUTTER_NOTIFICATION_CLICK", // For older SDKs
      type 
    },
    token: fcmToken,
  };

  try {
    await admin.messaging().send(message);
    console.log(`Push sent successfully to ${userId}`);
  } catch (error) {
    console.error("FCM Error:", error);
  }
};
