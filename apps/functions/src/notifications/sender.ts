import * as admin from "firebase-admin";

export const sendPushNotification = async (
  userId: string,
  title: string,
  body: string,
  type: string, // Added type
  data: any = {}
) => {
  const db = admin.firestore();
  
  // 1. SAVE TO FIRESTORE (So it shows in the App's list)
  const notificationId = db.collection(`users/${userId}/notifications`).doc().id;
  await db.collection(`users/${userId}/notifications`).doc(notificationId).set({
    id: notificationId,
    type: type,
    title: title,
    body: body,
    senderName: "System", // Or dynamic
    senderAvatar: "https://firebasestorage.googleapis.com/v0/b/your-app.appspot.com/o/assets%2Fapp_logo.png?alt=media",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    read: false,
    ...data
  });

  // 2. SEND REAL-TIME PUSH
  const userDoc = await db.collection("users").doc(userId).get();
  const pushToken = userDoc.data()?.pushToken;

  if (!pushToken) return;

  const message = {
    notification: { title, body },
    data: { ...data, type },
    token: pushToken,
  };

  try {
    await admin.messaging().send(message);
  } catch (error) {
    console.error("Error sending push:", error);
  }
};
