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
const admin = __importStar(require("firebase-admin"));
const firebase_1 = require("../utils/firebase");
const sendPushNotification = async (userId, title, body, type, data = {}) => {
    try {
        const userDoc = await firebase_1.db.collection("users").doc(userId).get();
        if (!userDoc.exists)
            return;
        const userData = userDoc.data();
        // Support both array and map for tokens, prioritizing array for now
        const tokens = (userData === null || userData === void 0 ? void 0 : userData.fcmTokens) || [];
        if (!tokens.length)
            return;
        const message = {
            tokens: tokens,
            notification: {
                title,
                body,
            },
            data: Object.assign({ type }, data),
            android: {
                notification: {
                    icon: "ic_notification",
                    color: "#FF4D67",
                },
            },
            webpush: {
                headers: {
                    Urgency: "high",
                },
                notification: {
                    icon: "/icons/icon-192x192.png",
                    badge: "/icons/badge-72x72.png",
                },
                fcmOptions: {
                    link: data.url || "/",
                }
            },
            apns: {
                payload: {
                    aps: {
                        alert: {
                            title,
                            body,
                        },
                        badge: 1,
                        sound: "default",
                    },
                },
            },
        };
        const response = await admin.messaging().sendEachForMulticast(message);
        if (response.failureCount > 0) {
            const failedTokens = [];
            response.responses.forEach((resp, idx) => {
                if (!resp.success) {
                    // @ts-ignore: errorInfo exists on failure
                    const error = resp.error;
                    if ((error === null || error === void 0 ? void 0 : error.code) === 'messaging/invalid-registration-token' ||
                        (error === null || error === void 0 ? void 0 : error.code) === 'messaging/registration-token-not-registered') {
                        failedTokens.push(tokens[idx]);
                    }
                }
            });
            if (failedTokens.length > 0) {
                await firebase_1.db.collection("users").doc(userId).update({
                    fcmTokens: admin.firestore.FieldValue.arrayRemove(...failedTokens)
                });
            }
        }
    }
    catch (error) {
        console.error("Error sending push notification:", error);
    }
};
exports.sendPushNotification = sendPushNotification;
const sendBroadcastNotification = async (title, body, data = {}) => {
    // This is a heavy operation. For production, consider using Topic Messaging or Batched processing.
    // For this implementation, we will use topic 'all_users' if clients subscribe to it,
    // OR fetch all users with tokens (expensive).
    // Requirement says "Secure Admin Notification System".
    // Best practice: Send to a topic "all_users".
    const message = {
        topic: 'all_users',
        notification: {
            title,
            body
        },
        data: Object.assign({ type: 'admin' }, data),
        android: {
            notification: {
                icon: "ic_notification",
                color: "#FF4D67",
            },
        },
        webpush: {
            notification: {
                icon: "/icons/icon-192x192.png",
            }
        }
    };
    try {
        await admin.messaging().send(message);
    }
    catch (error) {
        console.error("Error sending broadcast:", error);
        // Fallback or detailed error handling
    }
};
exports.sendBroadcastNotification = sendBroadcastNotification;
//# sourceMappingURL=sender.js.map