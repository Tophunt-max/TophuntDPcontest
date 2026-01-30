import * as functions from "firebase-functions";
import { sendPushNotification } from "./sender";
import { auth } from "../utils/firebase";

// This function acts as a bridge for the Cloudflare Worker to send Chat Notifications
export const sendChatNotificationBridge = functions.https.onRequest(async (req, res) => {
  // Simple check: In production, use an API Key or Bearer Token for security
  const apiKey = req.headers['x-bridge-key'];
  if (apiKey !== 'your-secure-shared-key') { // Set this in Firebase Config
     res.status(403).send('Unauthorized');
     return;
  }

  const { recipientId, senderName, text, chatId } = req.body;

  if (!recipientId || !senderName || !text) {
    res.status(400).send('Missing parameters');
    return;
  }

  try {
    await sendPushNotification(
      recipientId,
      `New Message from ${senderName}`,
      text,
      'chat',
      {
        chatId: chatId,
        click_action: `tophunt://messages/chat/${chatId}`, // Deep link for Expo
      }
    );
    res.status(200).send('Notification sent');
  } catch (error) {
    console.error("Bridge Error:", error);
    res.status(500).send('Internal Error');
  }
});
