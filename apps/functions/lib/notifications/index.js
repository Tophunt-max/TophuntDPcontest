"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendChatNotification = void 0;
const firestore_1 = require("firebase-functions/v2/firestore");
const firebase_1 = require("../utils/firebase");
const messaging_1 = require("firebase-admin/messaging");
exports.sendChatNotification = (0, firestore_1.onDocumentCreated)({
    document: 'chats/{chatId}/messages/{messageId}',
    region: 'us-central1',
    // Removed database: 'dpcontest' to use default
    maxInstances: 2,
    cpu: 0.25,
    memory: '256MiB'
}, async (event) => {
    const snap = event.data;
    if (!snap) {
        console.log("No data associated with the event");
        return;
    }
    const message = snap.data();
    const chatId = event.params.chatId;
    const chatRef = firebase_1.db.collection('chats').doc(chatId);
    const chatDoc = await chatRef.get();
    const chat = chatDoc.data();
    if (chat && chat.users) {
        const recipientId = chat.users.find((uid) => uid !== message.user._id);
        if (!recipientId) {
            console.log("Recipient not found");
            return;
        }
        const userRef = firebase_1.db.collection('users').doc(recipientId);
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