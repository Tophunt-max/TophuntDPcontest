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
exports.cleanupExpiredStories = exports.deleteStory = exports.createStory = exports.generateStoryUploadUrl = void 0;
const functions = __importStar(require("firebase-functions/v2"));
const https_1 = require("firebase-functions/v2/https");
const logger = __importStar(require("firebase-functions/logger"));
const client_s3_1 = require("@aws-sdk/client-s3");
const s3_request_presigner_1 = require("@aws-sdk/s3-request-presigner");
const uuid_1 = require("uuid");
const dotenv = __importStar(require("dotenv"));
const firebase_1 = require("../utils/firebase"); // Changed dpDb to db
dotenv.config();
const S3_BUCKET = process.env.S3_BUCKET;
const S3_REGION = process.env.S3_REGION;
const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY_ID;
const S3_SECRET_KEY = process.env.S3_SECRET_ACCESS_KEY;
// Log environment variables during initialization
logger.info("S3_BUCKET:", S3_BUCKET ? "*****" : "Not Set");
logger.info("S3_REGION:", S3_REGION ? "*****" : "Not Set");
logger.info("S3_ACCESS_KEY:", S3_ACCESS_KEY ? "*****" : "Not Set"); // Mask sensitive info
logger.info("S3_SECRET_KEY:", S3_SECRET_KEY ? "*****" : "Not Set"); // Mask sensitive info
const s3Client = new client_s3_1.S3Client({
    region: S3_REGION,
    credentials: {
        accessKeyId: S3_ACCESS_KEY,
        secretAccessKey: S3_SECRET_KEY,
    },
});
const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "video/mp4", "video/quicktime"];
const getExtension = (mimeType) => {
    switch (mimeType) {
        case "image/jpeg": return ".jpg";
        case "image/png": return ".png";
        case "image/webp": return ".webp";
        case "video/mp4": return ".mp4";
        case "video/quicktime": return ".mov";
        default: return "";
    }
};
const FUNCTION_CONFIG = {
    region: "us-central1", // Optimized for free tier
    cpu: 1, // Increased to 1
    concurrency: 80,
    memory: "256MiB",
    timeoutSeconds: 60,
    minInstances: 0,
    maxInstances: 2,
    cors: true
};
exports.generateStoryUploadUrl = (0, https_1.onCall)(FUNCTION_CONFIG, async (request) => {
    if (!request.auth) {
        throw new https_1.HttpsError("unauthenticated", "User must be logged in.");
    }
    const fileType = request.data.fileType;
    if (!ALLOWED_MIME_TYPES.includes(fileType)) {
        throw new https_1.HttpsError("invalid-argument", "Invalid file type.");
    }
    if (!S3_BUCKET || !S3_REGION || !S3_ACCESS_KEY || !S3_SECRET_KEY) {
        logger.error("S3 environment variables are not fully set in generateStoryUploadUrl.", {
            S3_BUCKET_SET: !!S3_BUCKET,
            S3_REGION_SET: !!S3_REGION,
            S3_ACCESS_KEY_SET: !!S3_ACCESS_KEY,
            S3_SECRET_KEY_SET: !!S3_SECRET_KEY,
        });
        throw new https_1.HttpsError("internal", "Server configuration error: S3 credentials missing.");
    }
    const folder = fileType.startsWith('video/') ? 'stories/videos' : 'stories/images';
    const extension = getExtension(fileType);
    const fileKey = `${folder}/${(0, uuid_1.v4)()}${extension}`;
    const publicUrl = `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com/${fileKey}`;
    const command = new client_s3_1.PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: fileKey,
        ContentType: fileType,
    });
    try {
        logger.info(`Generating signed URL for S3 Bucket: ${S3_BUCKET}, Key: ${fileKey}, Region: ${S3_REGION}`);
        const uploadUrl = await (0, s3_request_presigner_1.getSignedUrl)(s3Client, command, { expiresIn: 3600 });
        logger.info("Signed URL generated successfully.");
        return { uploadUrl, fileKey, publicUrl };
    }
    catch (error) {
        logger.error("Error generating Story S3 upload URL:", {
            error: error.message,
            code: error.code || 'N/A',
            name: error.name || 'Error',
            stack: error.stack || 'No stack trace available'
        });
        throw new https_1.HttpsError("internal", "Could not generate upload URL.");
    }
});
exports.createStory = (0, https_1.onCall)(FUNCTION_CONFIG, async (request) => {
    var _a;
    // Removed dependency on dpDb specific property
    const { mediaUrl, mediaType, visibility = 'followers', overlayText = null, textPosition = null, mentions = [] } = request.data;
    logger.info("createStory started", {
        uid: (_a = request.auth) === null || _a === void 0 ? void 0 : _a.uid,
        mediaUrl,
        mediaType,
        visibility,
        overlayText,
        textPosition,
        mentions
    });
    if (!request.auth) {
        logger.error("Authentication failed");
        throw new https_1.HttpsError("unauthenticated", "User must be logged in.");
    }
    if (!mediaUrl || !mediaType) {
        logger.error("Missing required fields", { mediaUrl, mediaType });
        throw new https_1.HttpsError("invalid-argument", "mediaUrl and mediaType are required.");
    }
    try {
        const userId = request.auth.uid;
        logger.info(`Fetching user document for userId: ${userId}`);
        const userDoc = await firebase_1.db.collection("users").doc(userId).get();
        const userData = userDoc.data();
        logger.info("User data fetched:", userData);
        const mentionedUids = [];
        if (mentions && mentions.length > 0) {
            logger.info(`Processing mentions: ${mentions.join(', ')}`);
            const usersRef = firebase_1.db.collection("users");
            const batches = [];
            for (let i = 0; i < mentions.length; i += 10) {
                const batch = mentions.slice(i, i + 10);
                const q = usersRef.where("username", "in", batch);
                batches.push(q.get());
            }
            const snapshots = await Promise.all(batches);
            snapshots.forEach(snap => {
                snap.forEach(doc => mentionedUids.push(doc.id));
            });
            logger.info(`Mentioned UIDs resolved: ${mentionedUids.join(', ')}`);
        }
        const storyData = {
            userId,
            username: (userData === null || userData === void 0 ? void 0 : userData.username) || 'Unknown',
            avatarUrl: (userData === null || userData === void 0 ? void 0 : userData.profileImageUrl) || '',
            mediaUrl,
            mediaType,
            visibility,
            overlayText,
            textPosition,
            mentions: mentionedUids,
            createdAt: firebase_1.admin.firestore.FieldValue.serverTimestamp(),
            expiresAt: firebase_1.admin.firestore.Timestamp.fromDate(new Date(Date.now() + 24 * 60 * 60 * 1000)),
        };
        logger.info("Story data prepared for Firestore:", storyData);
        const storyRef = await firebase_1.db.collection("stories").add(storyData);
        if (mentionedUids.length > 0) {
            logger.info("Creating notifications for mentioned users.");
            const batch = firebase_1.db.batch();
            mentionedUids.forEach(uid => {
                const notifRef = firebase_1.db.collection("notifications").doc();
                batch.set(notifRef, {
                    recipientId: uid,
                    senderId: userId,
                    type: 'story_mention',
                    storyId: storyRef.id,
                    message: `${userData === null || userData === void 0 ? void 0 : userData.username} mentioned you in their story.`,
                    read: false,
                    createdAt: firebase_1.admin.firestore.FieldValue.serverTimestamp()
                });
            });
            await batch.commit();
            logger.info("Notifications batch committed.");
        }
        logger.info(`Story record created successfully with ID: ${storyRef.id}`);
        return {
            success: true,
            storyId: storyRef.id
        };
    }
    catch (error) {
        logger.error("Error creating story record:", {
            error: error.message,
            code: error.code || 'N/A',
            name: error.name || 'Error',
            stack: error.stack || 'No stack trace available'
        });
        throw new https_1.HttpsError("internal", `Failed to save to database: ${error.message}`);
    }
});
exports.deleteStory = (0, https_1.onCall)(FUNCTION_CONFIG, async (request) => {
    if (!request.auth) {
        throw new https_1.HttpsError("unauthenticated", "User must be logged in.");
    }
    const { storyId } = request.data;
    if (!storyId) {
        throw new https_1.HttpsError("invalid-argument", "Story ID is required.");
    }
    try {
        const storyRef = firebase_1.db.collection("stories").doc(storyId);
        const storyDoc = await storyRef.get();
        if (!storyDoc.exists) {
            throw new https_1.HttpsError("not-found", "Story not found.");
        }
        const storyData = storyDoc.data();
        if ((storyData === null || storyData === void 0 ? void 0 : storyData.userId) !== request.auth.uid) {
            throw new https_1.HttpsError("permission-denied", "You can only delete your own stories.");
        }
        // Delete from S3 if mediaUrl exists
        if ((storyData === null || storyData === void 0 ? void 0 : storyData.mediaUrl) && S3_BUCKET) {
            try {
                // Extract Key from URL
                // Example URL: https://BUCKET.s3.REGION.amazonaws.com/stories/images/FILE.jpg
                const urlParts = storyData.mediaUrl.split('.amazonaws.com/');
                if (urlParts.length > 1) {
                    const fileKey = urlParts[1];
                    const command = new client_s3_1.DeleteObjectCommand({
                        Bucket: S3_BUCKET,
                        Key: fileKey,
                    });
                    await s3Client.send(command);
                    logger.info(`Deleted S3 object: ${fileKey}`);
                }
            }
            catch (s3Error) {
                logger.error("Failed to delete from S3:", s3Error);
                // Continue to delete from DB even if S3 fails
            }
        }
        await storyRef.delete();
        logger.info(`Story ${storyId} deleted by user ${request.auth.uid}`);
        return { success: true };
    }
    catch (error) {
        logger.error("Error deleting story:", error);
        throw new https_1.HttpsError("internal", error.message);
    }
});
exports.cleanupExpiredStories = functions.scheduler.onSchedule({
    schedule: "every 24 hours",
    region: "us-central1",
    cpu: 1, // Increased to 1 to match global settings logic if needed
    memory: "256MiB",
}, async (event) => {
    const now = firebase_1.admin.firestore.Timestamp.now();
    const storiesRef = firebase_1.db.collection("stories");
    const expiredStoriesQuery = storiesRef.where("expiresAt", "<=", now);
    const snapshot = await expiredStoriesQuery.get();
    if (snapshot.empty) {
        logger.info("No expired stories to delete.");
        return;
    }
    const batch = firebase_1.db.batch();
    snapshot.docs.forEach((doc) => {
        batch.delete(doc.ref);
    });
    await batch.commit();
    logger.info(`Deleted ${snapshot.size} expired stories.`);
});
//# sourceMappingURL=index.js.map