"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendBroadcastToAllUsers = exports.createNotification = void 0;
const firebase_1 = require("../utils/firebase");
const firestore_1 = require("firebase-admin/firestore");
const sender_1 = require("./sender");
const createNotification = async (recipientId, notification) => {
    if (!recipientId)
        return;
    try {
        // Create Firestore Notification
        await firebase_1.db.collection("notifications").doc(recipientId).collection("items").add(Object.assign(Object.assign({}, notification), { read: false, createdAt: firestore_1.FieldValue.serverTimestamp() }));
        // Send Push
        await (0, sender_1.sendPushNotification)(recipientId, notification.title, notification.body, notification.type, Object.assign({ targetId: notification.targetId, image: notification.image || "", click_action: "FLUTTER_NOTIFICATION_CLICK" }, (notification.data || {})));
    }
    catch (e) {
        console.error("Error creating notification", e);
    }
};
exports.createNotification = createNotification;
const sendBroadcastToAllUsers = async (title, body, imageUrl, data) => {
    let sentCount = 0;
    try {
        const usersSnapshot = await firebase_1.db.collection("users").get();
        // Parallel execution for better performance
        const promises = usersSnapshot.docs.map(async (doc) => {
            const userId = doc.id;
            // Skip users without tokens if optimization needed, but createNotification handles checks
            await (0, exports.createNotification)(userId, {
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
    }
    catch (error) {
        console.error("Error in broadcast:", error);
    }
    return sentCount;
};
exports.sendBroadcastToAllUsers = sendBroadcastToAllUsers;
//# sourceMappingURL=utils.js.map