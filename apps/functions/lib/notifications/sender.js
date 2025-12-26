"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendPushNotification = void 0;
const admin = __importStar(require("firebase-admin"));
const sendPushNotification = async (userId, title, body, type, // Added type
data = {}) => {
    var _a;
    const db = admin.firestore();
    // 1. SAVE TO FIRESTORE (So it shows in the App's list)
    const notificationId = db.collection(`users/${userId}/notifications`).doc().id;
    await db.collection(`users/${userId}/notifications`).doc(notificationId).set(Object.assign({ id: notificationId, type: type, title: title, body: body, senderName: "System", senderAvatar: "https://firebasestorage.googleapis.com/v0/b/your-app.appspot.com/o/assets%2Fapp_logo.png?alt=media", createdAt: admin.firestore.FieldValue.serverTimestamp(), read: false }, data));
    // 2. SEND REAL-TIME PUSH
    const userDoc = await db.collection("users").doc(userId).get();
    const pushToken = (_a = userDoc.data()) === null || _a === void 0 ? void 0 : _a.pushToken;
    if (!pushToken)
        return;
    const message = {
        notification: { title, body },
        data: Object.assign(Object.assign({}, data), { type }),
        token: pushToken,
    };
    try {
        await admin.messaging().send(message);
    }
    catch (error) {
        console.error("Error sending push:", error);
    }
};
exports.sendPushNotification = sendPushNotification;
//# sourceMappingURL=sender.js.map