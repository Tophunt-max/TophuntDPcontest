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
        // 1. Create Firestore Notification Item
        const notificationRef = firebase_1.db.collection("notifications").doc(recipientId).collection("items").doc();
        const batch = firebase_1.db.batch();
        batch.set(notificationRef, Object.assign(Object.assign({}, notification), { id: notificationRef.id, read: false, createdAt: firestore_1.FieldValue.serverTimestamp() }));
        // 2. Increment Unread Counter (Production Grade Experience)
        const userRef = firebase_1.db.collection("users").doc(recipientId);
        batch.update(userRef, {
            unreadNotificationsCount: firestore_1.FieldValue.increment(1),
            updatedAt: firestore_1.FieldValue.serverTimestamp()
        });
        await batch.commit();
        // 3. Send Push Notification
        await (0, sender_1.sendPushNotification)(recipientId, notification.title, notification.body, notification.type, Object.assign({ targetId: notification.targetId, image: notification.image || "", click_action: "FLUTTER_NOTIFICATION_CLICK" }, (notification.data || {})));
    }
    catch (e) {
        console.error("Error creating notification", e);
    }
};
exports.createNotification = createNotification;
/**
 * PRODUCTION BROADCAST: Using FCM Topics for infinite scalability.
 */
const sendBroadcastToAllUsers = async (title, body, imageUrl, data) => {
    try {
        // For production, we use the Topic system because looping through all users
        // is slow and expensive (O(N) vs O(1) FCM request).
        await (0, sender_1.sendBroadcastNotification)(title, body, Object.assign(Object.assign({}, data), { image: imageUrl || "", targetId: "broadcast" }));
        // Note: Broadcasts to Topics don't usually create individual Firestore notifications
        // because it would be too many writes. If you NEED it in their "In-App" Inbox,
        // it's better to show a separate "Global Announcements" section.
        return true;
    }
    catch (error) {
        console.error("Error in broadcast:", error);
        return false;
    }
};
exports.sendBroadcastToAllUsers = sendBroadcastToAllUsers;
//# sourceMappingURL=utils.js.map