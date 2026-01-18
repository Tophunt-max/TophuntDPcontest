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
exports.onIncomingCall = exports.onNewChatMessage = void 0;
const firestore_1 = require("firebase-functions/v2/firestore");
const database_1 = require("firebase-functions/v2/database");
const admin = __importStar(require("firebase-admin"));
/**
 * TRIGGER: New Chat Message
 * Sends a push notification to the recipient of a message.
 */
exports.onNewChatMessage = (0, firestore_1.onDocumentCreated)("chats/{chatId}/messages/{messageId}", async (event) => {
    var _a, _b, _c, _d;
    const messageData = (_a = event.data) === null || _a === void 0 ? void 0 : _a.data();
    if (!messageData)
        return;
    const { chatId, senderId, content, type } = messageData;
    // Skip notifications for system messages
    if (senderId === 'system')
        return;
    // 1. Get Chat Metadata to find the recipient
    const chatDoc = await admin.firestore().doc(`chats/${chatId}`).get();
    const chatData = chatDoc.data();
    if (!chatData)
        return;
    const recipientId = chatData.participants.find((id) => id !== senderId);
    if (!recipientId)
        return;
    const senderName = ((_c = (_b = chatData.participantsData) === null || _b === void 0 ? void 0 : _b[senderId]) === null || _c === void 0 ? void 0 : _c.displayName) || "Someone";
    // 2. Get Recipient's FCM Token
    const userDoc = await admin.firestore().doc(`users/${recipientId}`).get();
    const fcmToken = (_d = userDoc.data()) === null || _d === void 0 ? void 0 : _d.fcmToken;
    if (!fcmToken)
        return;
    // 3. Prepare Notification
    const payload = {
        notification: {
            title: senderName,
            body: type === 'text' ? content : `Sent a ${type.replace('_', ' ')}`,
        },
        data: {
            type: "message",
            chatId: chatId,
            senderId: senderId,
            url: `/messages/chat/${chatId}`
        },
        token: fcmToken
    };
    // 4. Send
    try {
        await admin.messaging().send(payload);
        console.log(`Notification sent to ${recipientId}`);
    }
    catch (error) {
        console.error("Error sending chat notification:", error);
    }
});
/**
 * TRIGGER: Incoming Call (RTDB)
 * Sends a high-priority notification for incoming calls.
 */
exports.onIncomingCall = (0, database_1.onValueCreated)({
    ref: "/calls/{chatId}",
    instance: "tophuntdpcontest",
    region: "us-central1"
}, async (event) => {
    var _a, _b, _c, _d, _e;
    const callData = (_a = event.data) === null || _a === void 0 ? void 0 : _a.val();
    if (!callData || callData.status !== 'initiating')
        return;
    const { chatId, callerId, receiverId, type } = callData;
    // 1. Get Caller Info
    const chatDoc = await admin.firestore().doc(`chats/${chatId}`).get();
    const callerName = ((_d = (_c = (_b = chatDoc.data()) === null || _b === void 0 ? void 0 : _b.participantsData) === null || _c === void 0 ? void 0 : _c[callerId]) === null || _d === void 0 ? void 0 : _d.displayName) || "Someone";
    // 2. Get Receiver's FCM Token
    const userDoc = await admin.firestore().doc(`users/${receiverId}`).get();
    const fcmToken = (_e = userDoc.data()) === null || _e === void 0 ? void 0 : _e.fcmToken;
    if (!fcmToken)
        return;
    // 3. Prepare Call Notification (High Priority)
    const payload = {
        notification: {
            title: `Incoming ${type} call`,
            body: `${callerName} is calling you...`,
        },
        data: {
            type: "call",
            chatId: chatId,
            callType: type,
            url: `/messages/chat/${chatId}`
        },
        android: {
            priority: "high",
            notification: {
                channelId: "calls", // Requires "calls" channel setup in Android
                sound: "default",
            }
        },
        token: fcmToken
    };
    try {
        await admin.messaging().send(payload);
        console.log(`Call notification sent to ${receiverId}`);
    }
    catch (error) {
        console.error("Error sending call notification:", error);
    }
});
//# sourceMappingURL=chatTriggers.js.map