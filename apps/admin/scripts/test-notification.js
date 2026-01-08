const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

async function sendTestNotification(uid) {
  console.log(`Sending test notification to: ${uid}`);

  const notification = {
    title: "Test Notification! 🚀",
    body: "Ye ek production-grade test notification hai.",
    type: "system",
    read: false,
    targetId: "test-target",
    senderId: "admin-system",
    senderName: "TopHunt System",
    senderAvatar: "https://ui-avatars.com/api/?name=System",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  try {
    // 1. Save to Firestore
    const notifRef = db.collection("notifications").doc(uid).collection("items").doc();
    await notifRef.set(notification);
    console.log("✅ Saved to Firestore: notifications/" + uid + "/items/" + notifRef.id);

    // 2. Trigger Push (Optional: If you want to trigger the function, 
    // we can just create a dummy comment instead)
    console.log("Tip: Agar aapne Cloud Functions deploy kar diye hain, toh ye automatically push bhej dega.");
    
  } catch (error) {
    console.error("❌ Error:", error);
  }
}

// Get UID from command line argument
const userUid = process.argv[2];
if (!userUid) {
  console.log("Usage: node test-notification.js <USER_UID>");
  process.exit(1);
}

sendTestNotification(userUid);
