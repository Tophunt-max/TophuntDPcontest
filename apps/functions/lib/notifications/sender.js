"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendPushNotification = void 0;
const firebase_1 = require("../utils/firebase");
/**
 * Sends a push notification via FCM and saves it to Firestore.
 */
const sendPushNotification = async (userId, title, body, type, data = {}) => {
    var _a, _b;
    // 1. SAVE TO FIRESTORE (Global notifications collection or User sub-collection)
    const notifRef = firebase_1.db.collection("notifications").doc();
    await notifRef.set({
        recipientUid: userId,
        type,
        title,
        body,
        data,
        read: false,
        createdAt: firebase_1.admin.firestore.FieldValue.serverTimestamp(),
    });
    // 2. SEND FCM PUSH
    const userDoc = await firebase_1.db.collection("users").doc(userId).get();
    const fcmToken = ((_a = userDoc.data()) === null || _a === void 0 ? void 0 : _a.fcmToken) || ((_b = userDoc.data()) === null || _b === void 0 ? void 0 : _b.pushToken);
    if (!fcmToken) {
        console.log(`No FCM token found for user ${userId}`);
        return;
    }
    const message = {
        notification: { title, body },
        data: Object.assign(Object.assign({}, data), { click_action: "FLUTTER_NOTIFICATION_CLICK", // For older SDKs
            type }),
        token: fcmToken,
    };
    try {
        await firebase_1.admin.messaging().send(message);
        console.log(`Push sent successfully to ${userId}`);
    }
    catch (error) {
        console.error("FCM Error:", error);
    }
};
exports.sendPushNotification = sendPushNotification;
//# sourceMappingURL=sender.js.map