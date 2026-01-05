import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { db } from "../utils/firebase";
import { getMessaging } from "firebase-admin/messaging";
import { MemoryOption } from "firebase-functions/v2/options";

// CPU must be >= 1 for concurrency, but since this is an event trigger (not HTTP),
// we can use lower CPU and 1 instance.
export const sendChatNotification = onDocumentCreated({
    document: 'chats/{chatId}/messages/{messageId}',
    region: 'us-central1',
    maxInstances: 1, // Single instance is fine for chats usually
    cpu: 1, // INCREASED TO 1 to fix validation error (concurrency conflict)
    memory: '256MiB' as MemoryOption
}, async (event) => {
    const snap = event.data;
    if (!snap) {
        console.log("No data associated with the event");
        return;
    }

    const message = snap.data();
    const chatId = event.params.chatId;

    const chatRef = db.collection('chats').doc(chatId);
    const chatDoc = await chatRef.get();
    const chat = chatDoc.data();

    if (chat && chat.users) {
        const recipientId = chat.users.find((uid: string) => uid !== message.user._id);
        if (!recipientId) {
            console.log("Recipient not found");
            return;
        }

        const userRef = db.collection('users').doc(recipientId);
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
