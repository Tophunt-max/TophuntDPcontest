"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.notify = void 0;
const https_1 = require("firebase-functions/v2/https");
const utils_1 = require("./utils");
/**
 * SINGLE UNIFIED NOTIFICATION HANDLER
 * This replaces 15+ background triggers with one scalable HTTP API.
 */
exports.notify = (0, https_1.onCall)({
    region: "us-central1",
    memory: "256MiB",
    maxInstances: 5, // Extremely low to stay within your Google Cloud Quota
    cpu: 0.1, // Lower CPU to fit in free tier / limited quota
    cors: true
}, async (request) => {
    var _a;
    // 1. Auth & Security
    if (!request.auth) {
        throw new https_1.HttpsError("unauthenticated", "Authentication required.");
    }
    const { type, recipientId, data } = request.data;
    const actorId = request.auth.uid;
    if (!type || !recipientId) {
        throw new https_1.HttpsError("invalid-argument", "Missing required fields: type, recipientId.");
    }
    // Skip if actor is recipient (except for wallet/system)
    if (actorId === recipientId && !["WALLET", "SYSTEM", "MILESTONE"].includes(type)) {
        return { success: true, message: "Self-notification ignored." };
    }
    try {
        let title = "";
        let body = "";
        let targetId = data.targetId || "profile";
        let image = data.image || "";
        // 2. Routing Engine (Logic Merged from 17+ Triggers)
        switch (type) {
            case "LIKE":
                title = data.targetType === "comment" ? "Comment Liked ❤️" : "New Like ❤️";
                body = `${data.actorName || "Someone"} liked your ${data.targetType || "post"}.`;
                break;
            case "COMMENT":
                title = data.isReply ? "New Reply ↩️" : "New Comment 💬";
                body = `${data.actorName || "Someone"} ${data.isReply ? 'replied' : 'commented'}: "${(_a = data.text) === null || _a === void 0 ? void 0 : _a.substring(0, 50)}"`;
                break;
            case "FOLLOW":
                title = "New Follower! 🌟";
                body = `${data.actorName || "Someone"} started following you.`;
                break;
            case "BATTLE_INVITE":
                title = "New Challenge! ⚔️";
                body = `${data.actorName || "Someone"} challenged you to a battle!`;
                break;
            case "BATTLE_START":
                title = "Challenge Accepted! 🚀";
                body = `Your battle with ${data.actorName || "Someone"} has started.`;
                break;
            case "BATTLE_WIN":
                title = "You Won! 🏆";
                body = "Congratulations! You won the battle. Check your rewards.";
                break;
            case "WALLET":
                title = "Coins Received 💰";
                body = `You received ${data.amount} coins for ${data.reason || "activity"}.`;
                break;
            case "CHAT_MESSAGE":
                title = data.actorName || "New Message";
                body = data.messageType === 'text' ? data.text : `Sent you a ${data.messageType || "file"}`;
                break;
            case "SYSTEM":
                title = data.title || "System Notification";
                body = data.body || "";
                break;
            default:
                throw new https_1.HttpsError("invalid-argument", `Unknown notification type: ${type}`);
        }
        // 3. Centralized Database Write & FCM Dispatch
        await (0, utils_1.createNotification)(recipientId, {
            title,
            body,
            type: type.toLowerCase(),
            targetId,
            image,
            data: Object.assign(Object.assign({}, data), { senderId: actorId })
        });
        return { success: true };
    }
    catch (error) {
        console.error("Unified Notify Error:", error);
        throw new https_1.HttpsError("internal", error.message || "Notification delivery failed.");
    }
});
//# sourceMappingURL=handler.js.map