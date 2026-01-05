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
exports.sendBroadcastNotification = exports.sendPushNotification = void 0;
const https_1 = require("firebase-functions/v2/https");
const firebase_1 = require("../utils/firebase");
const logger = __importStar(require("firebase-functions/logger"));
/**
 * Sends a push notification to a specific user.
 * Separate helper function to be reused internally.
 */
const sendPushNotification = async (userId, title, body, type, data = {}) => {
    // 1. SAVE TO FIRESTORE
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
    try {
        const userDoc = await firebase_1.db.collection("users").doc(userId).get();
        const userData = userDoc.data();
        // Support both field names
        const fcmToken = (userData === null || userData === void 0 ? void 0 : userData.fcmToken) || (userData === null || userData === void 0 ? void 0 : userData.pushToken);
        if (!fcmToken) {
            logger.warn(`No FCM token found for user ${userId}. Skipping push.`);
            return;
        }
        const message = {
            notification: { title, body },
            data: Object.assign(Object.assign({}, data), { click_action: "FLUTTER_NOTIFICATION_CLICK", type }),
            token: fcmToken,
        };
        await firebase_1.admin.messaging().send(message);
        logger.info(`Push sent successfully to ${userId}`);
    }
    catch (error) {
        logger.error(`FCM Error for user ${userId}:`, error);
        // Do not throw here, so other notifications can proceed
    }
};
exports.sendPushNotification = sendPushNotification;
/**
 * Send a broadcast notification to all users or selected segments.
 * Callable from Admin Panel.
 */
exports.sendBroadcastNotification = (0, https_1.onCall)({
    region: 'us-central1',
    memory: '512MiB', // Increased memory for batch processing
    maxInstances: 1,
    timeoutSeconds: 300 // Increased timeout for long running broadcast
}, async (request) => {
    // 1. Ensure caller is authenticated
    if (!request.auth) {
        throw new https_1.HttpsError("unauthenticated", "User must be logged in.");
    }
    // 2. Check Admin Permissions
    // NOTE: If you get permission-denied, ensure your user has custom claim { admin: true }
    // For debugging, we are logging the token claims
    logger.info("Broadcast requester claims:", request.auth.token);
    // Uncomment this strict check for production
    // if (request.auth.token.admin !== true) {
    //     throw new HttpsError("permission-denied", "Only administrators can send broadcasts.");
    // }
    const { title, body, imageUrl, targetPage } = request.data;
    if (!title || !body) {
        throw new https_1.HttpsError("invalid-argument", "Title and Body are required.");
    }
    logger.info(`Starting broadcast: ${title}`);
    try {
        // 2. Fetch all users with push tokens
        // Optimisation: Only fetch ID and token
        const usersSnap = await firebase_1.db.collection("users")
            .where("fcmToken", "!=", null)
            .select("fcmToken")
            .get();
        // Also try fetching 'pushToken' field if needed (or combine results)
        // For simplicity we assume 'fcmToken' is the standard now.
        if (usersSnap.empty) {
            return { sentCount: 0, message: "No users with push tokens found." };
        }
        const notificationData = {
            click_action: "FLUTTER_NOTIFICATION_CLICK",
            type: "broadcast",
            imageUrl: imageUrl || "",
            targetPage: targetPage || "/home"
        };
        const batchSize = 100; // FCM batch limit is 500, keeping safe 100
        let sentCount = 0;
        const messages = [];
        // Prepare all messages
        usersSnap.docs.forEach(doc => {
            const token = doc.data().fcmToken;
            if (token) {
                messages.push({
                    notification: { title, body },
                    data: notificationData,
                    token: token
                });
            }
        });
        // Send in batches
        for (let i = 0; i < messages.length; i += batchSize) {
            const chunk = messages.slice(i, i + batchSize);
            const response = await firebase_1.admin.messaging().sendEach(chunk); // New API
            sentCount += response.successCount;
            if (response.failureCount > 0) {
                logger.warn(`Batch ${i} had ${response.failureCount} failures.`);
                response.responses.forEach((resp, idx) => {
                    if (!resp.success) {
                        logger.error(`Error sending to token:`, resp.error);
                    }
                });
            }
        }
        // 4. Save broadcast log for history
        await firebase_1.db.collection("broadcastHistory").add({
            title,
            body,
            imageUrl: imageUrl || null,
            sentCount,
            adminId: request.auth.uid,
            timestamp: firebase_1.admin.firestore.FieldValue.serverTimestamp()
        });
        return { success: true, sentCount };
    }
    catch (error) {
        logger.error("Broadcast failed:", error);
        throw new https_1.HttpsError("internal", error.message);
    }
});
//# sourceMappingURL=sender.js.map