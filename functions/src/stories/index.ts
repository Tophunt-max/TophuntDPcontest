import * as functions from "firebase-functions/v2";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { v4 as uuidv4 } from "uuid";
import * as dotenv from 'dotenv';
import { dpDb, admin } from "../utils/firebase";

dotenv.config();

const S3_BUCKET = process.env.S3_BUCKET;
const S3_REGION = process.env.S3_REGION;
const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY_ID;
const S3_SECRET_KEY = process.env.S3_SECRET_ACCESS_KEY;

const s3Client = new S3Client({
    region: S3_REGION,
    credentials: {
        accessKeyId: S3_ACCESS_KEY as string,
        secretAccessKey: S3_SECRET_KEY as string,
    },
});

const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "video/mp4", "video/quicktime"];

export const generateStoryUploadUrl = onCall({ region: "asia-south1", cors: true }, async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "User must be logged in.");
    }

    const fileType = request.data.fileType;
    if (!ALLOWED_MIME_TYPES.includes(fileType)) {
        throw new HttpsError("invalid-argument", "Invalid file type.");
    }
    
    if (!S3_BUCKET || !S3_REGION || !S3_ACCESS_KEY || !S3_SECRET_KEY) {
        throw new HttpsError("internal", "Server configuration error.");
    }

    const folder = fileType.startsWith('video/') ? 'stories/videos' : 'stories/images';
    const fileKey = `${folder}/${uuidv4()}`;
    const publicUrl = `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com/${fileKey}`;

    const command = new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: fileKey,
        ContentType: fileType,
    });

    try {
        const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
        return { uploadUrl, fileKey, publicUrl };
    } catch (error: any) {
        logger.error("Error generating Story S3 upload URL:", error);
        throw new HttpsError("internal", "Could not generate upload URL.");
    }
});

export const createStory = onCall({ region: "asia-south1", cors: true }, async (request) => {
    const dbId = (dpDb as any)._databaseId?.database || "dpcontest";
    logger.info("createStory started", { 
        uid: request.auth?.uid, 
        mediaUrl: request.data.mediaUrl,
        mediaType: request.data.mediaType,
        database: dbId
    });

    if (!request.auth) {
        logger.error("Authentication failed");
        throw new HttpsError("unauthenticated", "User must be logged in.");
    }

    const { mediaUrl, mediaType } = request.data;
    if (!mediaUrl || !mediaType) {
        logger.error("Missing required fields", { mediaUrl, mediaType });
        throw new HttpsError("invalid-argument", "mediaUrl and mediaType are required.");
    }

    try {
        const userId = request.auth.uid;
        
        // Fetch user data to denormalize
        const userDoc = await dpDb.collection("users").doc(userId).get();
        const userData = userDoc.data();
        
        logger.info(`Attempting to write story for user ${userId} to database ${dbId}`);
        
        const storyData = {
            userId,
            username: userData?.username || 'Unknown',
            avatarUrl: userData?.profileImageUrl || '',
            mediaUrl,
            mediaType,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            expiresAt: admin.firestore.Timestamp.fromDate(
                new Date(Date.now() + 24 * 60 * 60 * 1000)
            ),
        };

        const storyRef = await dpDb.collection("stories").add(storyData);

        logger.info(`Story record created successfully with ID: ${storyRef.id}`);

        return { 
            success: true, 
            storyId: storyRef.id,
            database: dbId 
        };
    } catch (error: any) {
        logger.error("Error creating story record:", {
            error: error.message,
            code: error.code,
            stack: error.stack
        });
        throw new HttpsError("internal", `Failed to save to database: ${error.message}`);
    }
});

export const cleanupExpiredStories = functions.scheduler.onSchedule({
    schedule: "every 24 hours",
    region: "asia-south1"
}, async (event) => {
    const now = admin.firestore.Timestamp.now();
    const storiesRef = dpDb.collection("stories");
    const expiredStoriesQuery = storiesRef.where("expiresAt", "<=", now);

    const snapshot = await expiredStoriesQuery.get();
    
    if (snapshot.empty) {
        logger.info("No expired stories to delete.");
        return;
    }

    const batch = dpDb.batch();
    snapshot.docs.forEach((doc: any) => {
      batch.delete(doc.ref);
    });

    await batch.commit();
    logger.info(`Deleted ${snapshot.size} expired stories.`);
});
