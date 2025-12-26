import { onDocumentCreated } from "firebase-functions/v2/firestore";
import * as admin from "firebase-admin";
import { getMessaging } from "firebase-admin/messaging";

admin.initializeApp();

export const sendChatNotification = onDocumentCreated('chats/{chatId}/messages/{messageId}', async (event) => {
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
        const recipientId = chat.users.find((uid: string) => uid !== message.user._id);
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
                await getMessaging().send(payload);
                console.log('Successfully sent message');
            } catch (error) {
                console.error('Error sending notification:', error);
            }
        }
    }
});