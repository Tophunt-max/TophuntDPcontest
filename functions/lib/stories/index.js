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
exports.cleanupExpiredStories = exports.createStory = exports.generateStoryUploadUrl = void 0;
const functions = __importStar(require("firebase-functions/v2"));
const https_1 = require("firebase-functions/v2/https");
const logger = __importStar(require("firebase-functions/logger"));
const client_s3_1 = require("@aws-sdk/client-s3");
const s3_request_presigner_1 = require("@aws-sdk/s3-request-presigner");
const uuid_1 = require("uuid");
const dotenv = __importStar(require("dotenv"));
const firebase_1 = require("../utils/firebase");
dotenv.config();
const S3_BUCKET = process.env.S3_BUCKET;
const S3_REGION = process.env.S3_REGION;
const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY_ID;
const S3_SECRET_KEY = process.env.S3_SECRET_ACCESS_KEY;
const s3Client = new client_s3_1.S3Client({
    region: S3_REGION,
    credentials: {
        accessKeyId: S3_ACCESS_KEY,
        secretAccessKey: S3_SECRET_KEY,
    },
});
const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "video/mp4", "video/quicktime"];
exports.generateStoryUploadUrl = (0, https_1.onCall)({ region: "asia-south1", cors: true }, async (request) => {
    if (!request.auth) {
        throw new https_1.HttpsError("unauthenticated", "User must be logged in.");
    }
    const fileType = request.data.fileType;
    if (!ALLOWED_MIME_TYPES.includes(fileType)) {
        throw new https_1.HttpsError("invalid-argument", "Invalid file type.");
    }
    if (!S3_BUCKET || !S3_REGION || !S3_ACCESS_KEY || !S3_SECRET_KEY) {
        throw new https_1.HttpsError("internal", "Server configuration error.");
    }
    const folder = fileType.startsWith('video/') ? 'stories/videos' : 'stories/images';
    const fileKey = `${folder}/${(0, uuid_1.v4)()}`;
    const publicUrl = `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com/${fileKey}`;
    const command = new client_s3_1.PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: fileKey,
        ContentType: fileType,
    });
    try {
        const uploadUrl = await (0, s3_request_presigner_1.getSignedUrl)(s3Client, command, { expiresIn: 3600 });
        return { uploadUrl, fileKey, publicUrl };
    }
    catch (error) {
        logger.error("Error generating Story S3 upload URL:", error);
        throw new https_1.HttpsError("internal", "Could not generate upload URL.");
    }
});
exports.createStory = (0, https_1.onCall)({ region: "asia-south1", cors: true }, async (request) => {
    var _a, _b;
    const dbId = ((_a = firebase_1.dpDb._databaseId) === null || _a === void 0 ? void 0 : _a.database) || "dpcontest";
    logger.info("createStory started", {
        uid: (_b = request.auth) === null || _b === void 0 ? void 0 : _b.uid,
        mediaUrl: request.data.mediaUrl,
        mediaType: request.data.mediaType,
        database: dbId
    });
    if (!request.auth) {
        logger.error("Authentication failed");
        throw new https_1.HttpsError("unauthenticated", "User must be logged in.");
    }
    const { mediaUrl, mediaType } = request.data;
    if (!mediaUrl || !mediaType) {
        logger.error("Missing required fields", { mediaUrl, mediaType });
        throw new https_1.HttpsError("invalid-argument", "mediaUrl and mediaType are required.");
    }
    try {
        const userId = request.auth.uid;
        // Fetch user data to denormalize
        const userDoc = await firebase_1.dpDb.collection("users").doc(userId).get();
        const userData = userDoc.data();
        logger.info(`Attempting to write story for user ${userId} to database ${dbId}`);
        const storyData = {
            userId,
            username: (userData === null || userData === void 0 ? void 0 : userData.username) || 'Unknown',
            avatarUrl: (userData === null || userData === void 0 ? void 0 : userData.profileImageUrl) || '',
            mediaUrl,
            mediaType,
            createdAt: firebase_1.admin.firestore.FieldValue.serverTimestamp(),
            expiresAt: firebase_1.admin.firestore.Timestamp.fromDate(new Date(Date.now() + 24 * 60 * 60 * 1000)),
        };
        const storyRef = await firebase_1.dpDb.collection("stories").add(storyData);
        logger.info(`Story record created successfully with ID: ${storyRef.id}`);
        return {
            success: true,
            storyId: storyRef.id,
            database: dbId
        };
    }
    catch (error) {
        logger.error("Error creating story record:", {
            error: error.message,
            code: error.code,
            stack: error.stack
        });
        throw new https_1.HttpsError("internal", `Failed to save to database: ${error.message}`);
    }
});
exports.cleanupExpiredStories = functions.scheduler.onSchedule({
    schedule: "every 24 hours",
    region: "asia-south1"
}, async (event) => {
    const now = firebase_1.admin.firestore.Timestamp.now();
    const storiesRef = firebase_1.dpDb.collection("stories");
    const expiredStoriesQuery = storiesRef.where("expiresAt", "<=", now);
    const snapshot = await expiredStoriesQuery.get();
    if (snapshot.empty) {
        logger.info("No expired stories to delete.");
        return;
    }
    const batch = firebase_1.dpDb.batch();
    snapshot.docs.forEach((doc) => {
        batch.delete(doc.ref);
    });
    await batch.commit();
    logger.info(`Deleted ${snapshot.size} expired stories.`);
});
//# sourceMappingURL=index.js.map