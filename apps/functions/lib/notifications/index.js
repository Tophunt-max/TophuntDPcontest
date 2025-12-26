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
exports.sendChatNotification = void 0;
const firestore_1 = require("firebase-functions/v2/firestore");
const admin = __importStar(require("firebase-admin"));
const messaging_1 = require("firebase-admin/messaging");
admin.initializeApp();
exports.sendChatNotification = (0, firestore_1.onDocumentCreated)('chats/{chatId}/messages/{messageId}', async (event) => {
    const snap = event.data;
    if (!snap) {
        console.log("No data associated with the event");
        return;
    }
    const message = snap.data();
    const chatId = event.params.chatId;
    const chatRef = admin.firestore().collection('chats').doc(chatId);
    const chatDoc = await chatRef.get();
    const chat = chatDoc.data();
    if (chat && chat.users) {
        const recipientId = chat.users.find((uid) => uid !== message.user._id);
        if (!recipientId) {
            console.log("Recipient not found");
            return;
        }
        const userRef = admin.firestore().collection('users').doc(recipientId);
        const userDoc = await userRef.get();
        const userData = userDoc.data();
        if (userData && userData.pushToken) {
            const payload = {
                token: userData.pushToken,
                notification: {
                    title: `New message from ${message.user.name}`,
                    body: message.text,
                },
            };
            try {
                await (0, messaging_1.getMessaging)().send(payload);
                console.log('Successfully sent message');
            }
            catch (error) {
                console.error('Error sending notification:', error);
            }
        }
    }
});
//# sourceMappingURL=index.js.map