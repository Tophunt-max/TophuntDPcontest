import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { onValueCreated } from "firebase-functions/v2/database";
import * as admin from "firebase-admin";

/**
 * TRIGGER: New Chat Message
 * Sends a push notification to the recipient of a message.
 */
export const onNewChatMessage = onDocumentCreated("chats/{chatId}/messages/{messageId}", async (event) => {
    const messageData = event.data?.data();
    if (!messageData) return;

    const { chatId, senderId, content, type } = messageData;

    // Skip notifications for system messages
    if (senderId === 'system') return;

    // 1. Get Chat Metadata to find the recipient
    const chatDoc = await admin.firestore().doc(`chats/${chatId}`).get();
    const chatData = chatDoc.data();
    if (!chatData) return;

    const recipientId = chatData.participants.find((id: string) => id !== senderId);
    if (!recipientId) return;

    const senderName = chatData.participantsData?.[senderId]?.displayName || "Someone";

    // 2. Get Recipient's FCM Token
    const userDoc = await admin.firestore().doc(`users/${recipientId}`).get();
    const fcmToken = userDoc.data()?.fcmToken;

    if (!fcmToken) return;

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
    } catch (error) {
        console.error("Error sending chat notification:", error);
    }
});

/**
 * TRIGGER: Incoming Call (RTDB)
 * Sends a high-priority notification for incoming calls.
 */
export const onIncomingCall = onValueCreated("/calls/{chatId}", async (event) => {
    const callData = event.data;
    if (!callData || callData.status !== 'initiating') return;

    const { chatId, callerId, receiverId, type } = callData;

    // 1. Get Caller Info
    const chatDoc = await admin.firestore().doc(`chats/${chatId}`).get();
    const callerName = chatDoc.data()?.participantsData?.[callerId]?.displayName || "Someone";

    // 2. Get Receiver's FCM Token
    const userDoc = await admin.firestore().doc(`users/${receiverId}`).get();
    const fcmToken = userDoc.data()?.fcmToken;

    if (!fcmToken) return;

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
        await admin.messaging().send(payload as any);
        console.log(`Call notification sent to ${receiverId}`);
    } catch (error) {
        console.error("Error sending call notification:", error);
    }
});
