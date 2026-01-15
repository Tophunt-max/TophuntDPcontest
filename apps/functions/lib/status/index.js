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
exports.statusHandler = void 0;
const https_1 = require("firebase-functions/v2/https");
const logger = __importStar(require("firebase-functions/logger"));
const firebase_1 = require("../utils/firebase");
const firestore_1 = require("firebase-admin/firestore");
const STATUS_CONFIG = {
    region: "us-central1",
    memory: "256MiB",
    timeoutSeconds: 60,
    cors: true,
};
/**
 * Unified Status/Story Handler
 * This is the new high-performance engine for your existing Stories.
 */
exports.statusHandler = (0, https_1.onCall)(STATUS_CONFIG, async (request) => {
    var _a, _b;
    if (!request.data || !request.data.action) {
        throw new https_1.HttpsError("invalid-argument", "Request must specify an 'action'.");
    }
    const { action } = request.data;
    const uid = (_a = request.auth) === null || _a === void 0 ? void 0 : _a.uid;
    if (!uid) {
        throw new https_1.HttpsError("unauthenticated", "User must be logged in.");
    }
    switch (action) {
        case "create": {
            const { mediaUrl, type, statusId, objectKey, overlayText, textPosition, mentions } = request.data;
            if (!mediaUrl || !type || !statusId) {
                throw new https_1.HttpsError("invalid-argument", "Media URL, type, and statusId are required.");
            }
            try {
                const userDoc = await firebase_1.db.collection("users").doc(uid).get();
                if (!userDoc.exists)
                    throw new https_1.HttpsError("not-found", "User profile not found.");
                const userData = userDoc.data();
                // Mapping to your existing Story schema for full compatibility
                const storyData = {
                    userId: uid,
                    username: (userData === null || userData === void 0 ? void 0 : userData.username) || "Unknown",
                    avatarUrl: (userData === null || userData === void 0 ? void 0 : userData.profileImageUrl) || null,
                    mediaUrl,
                    objectKey: objectKey || null, // Useful for R2 deletion
                    mediaType: type === 'status_video' ? 'video' : 'image', // Compatible with old UI
                    createdAt: firebase_1.admin.firestore.FieldValue.serverTimestamp(),
                    expiresAt: firestore_1.Timestamp.fromMillis(Date.now() + 24 * 60 * 60 * 1000),
                    viewsCount: 0,
                    overlayText: overlayText || null,
                    textPosition: textPosition || null,
                    mentions: mentions || [],
                    statusId // Reference to R2 file
                };
                // Saving to 'stories' collection so your existing app can see it
                await firebase_1.db.collection("stories").doc(statusId).set(storyData);
                logger.info(`Story (Status) created by ${uid}: ${statusId}`);
                return { success: true, storyId: statusId };
            }
            catch (error) {
                logger.error("Error creating story:", error);
                throw new https_1.HttpsError("internal", "Failed to create story.");
            }
        }
        case "view": {
            const { statusId } = request.data;
            if (!statusId)
                throw new https_1.HttpsError("invalid-argument", "statusId is required.");
            try {
                const storyRef = firebase_1.db.collection("stories").doc(statusId);
                await storyRef.update({
                    viewsCount: firebase_1.admin.firestore.FieldValue.increment(1)
                });
                return { success: true };
            }
            catch (error) {
                return { success: false };
            }
        }
        case "delete": {
            const { statusId } = request.data;
            if (!statusId)
                throw new https_1.HttpsError("invalid-argument", "statusId is required.");
            try {
                const storyRef = firebase_1.db.collection("stories").doc(statusId);
                const storyDoc = await storyRef.get();
                if (!storyDoc.exists)
                    throw new https_1.HttpsError("not-found", "Story not found.");
                if (((_b = storyDoc.data()) === null || _b === void 0 ? void 0 : _b.userId) !== uid) {
                    throw new https_1.HttpsError("permission-denied", "Unauthorized.");
                }
                await storyRef.delete();
                return { success: true };
            }
            catch (error) {
                throw new https_1.HttpsError("internal", "Deletion failed.");
            }
        }
        default:
            throw new https_1.HttpsError("invalid-argument", `Unknown action: ${action}`);
    }
});
//# sourceMappingURL=index.js.map