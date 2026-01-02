import * as functions from "firebase-functions/v2";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { v4 as uuidv4 } from "uuid";
import * as dotenv from 'dotenv';
import { db, admin } from "../utils/firebase"; // Changed dpDb to db
import { MemoryOption } from "firebase-functions/v2/options";

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

const s3Client = new S3Client({
    region: S3_REGION,
    credentials: {
        accessKeyId: S3_ACCESS_KEY as string,
        secretAccessKey: S3_SECRET_KEY as string,
    },
});

const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "video/mp4", "video/quicktime"];

const getExtension = (mimeType: string): string => {
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
    memory: "256MiB" as MemoryOption,
    timeoutSeconds: 60,
    minInstances: 0,
    maxInstances: 2,
    cors: true
};

export const generateStoryUploadUrl = onCall(FUNCTION_CONFIG, async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "User must be logged in.");
    }

    const fileType = request.data.fileType;
    if (!ALLOWED_MIME_TYPES.includes(fileType)) {
        throw new HttpsError("invalid-argument", "Invalid file type.");
    }
    
    if (!S3_BUCKET || !S3_REGION || !S3_ACCESS_KEY || !S3_SECRET_KEY) {
        logger.error("S3 environment variables are not fully set in generateStoryUploadUrl.", {
            S3_BUCKET_SET: !!S3_BUCKET,
            S3_REGION_SET: !!S3_REGION,
            S3_ACCESS_KEY_SET: !!S3_ACCESS_KEY,
            S3_SECRET_KEY_SET: !!S3_SECRET_KEY,
        });
        throw new HttpsError("internal", "Server configuration error: S3 credentials missing.");
    }

    const folder = fileType.startsWith('video/') ? 'stories/videos' : 'stories/images';
    const extension = getExtension(fileType);
    const fileKey = `${folder}/${uuidv4()}${extension}`;
    const publicUrl = `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com/${fileKey}`;

    const command = new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: fileKey,
        ContentType: fileType,
    });

    try {
        logger.info(`Generating signed URL for S3 Bucket: ${S3_BUCKET}, Key: ${fileKey}, Region: ${S3_REGION}`);
        const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
        logger.info("Signed URL generated successfully.");
        return { uploadUrl, fileKey, publicUrl };
    } catch (error: any) {
        logger.error("Error generating Story S3 upload URL:", {
            error: error.message,
            code: error.code || 'N/A',
            name: error.name || 'Error',
            stack: error.stack || 'No stack trace available'
        });
        throw new HttpsError("internal", "Could not generate upload URL.");
    }
});

export const createStory = onCall(FUNCTION_CONFIG, async (request) => {
    // Removed dependency on dpDb specific property
    const { 
        mediaUrl, 
        mediaType, 
        visibility = 'followers',
        overlayText = null,
        textPosition = null,
        mentions = []
    } = request.data;
    
    logger.info("createStory started", { 
        uid: request.auth?.uid, 
        mediaUrl,
        mediaType,
        visibility,
        overlayText,
        textPosition,
        mentions
    });

    if (!request.auth) {
        logger.error("Authentication failed");
        throw new HttpsError("unauthenticated", "User must be logged in.");
    }

    if (!mediaUrl || !mediaType) {
        logger.error("Missing required fields", { mediaUrl, mediaType });
        throw new HttpsError("invalid-argument", "mediaUrl and mediaType are required.");
    }

    try {
        const userId = request.auth.uid;
        logger.info(`Fetching user document for userId: ${userId}`);
        const userDoc = await db.collection("users").doc(userId).get();
        const userData = userDoc.data();
        logger.info("User data fetched:", userData);
        
        const mentionedUids: string[] = [];
        if (mentions && mentions.length > 0) {
            logger.info(`Processing mentions: ${mentions.join(', ')}`);
            const usersRef = db.collection("users");
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
            username: userData?.username || 'Unknown',
            avatarUrl: userData?.profileImageUrl || '',
            mediaUrl,
            mediaType,
            visibility, 
            overlayText,
            textPosition,
            mentions: mentionedUids,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            expiresAt: admin.firestore.Timestamp.fromDate(
                new Date(Date.now() + 24 * 60 * 60 * 1000)
            ),
        };
        logger.info("Story data prepared for Firestore:", storyData);

        const storyRef = await db.collection("stories").add(storyData);
        
        if (mentionedUids.length > 0) {
            logger.info("Creating notifications for mentioned users.");
            const batch = db.batch();
            mentionedUids.forEach(uid => {
                const notifRef = db.collection("notifications").doc();
                batch.set(notifRef, {
                    recipientId: uid,
                    senderId: userId,
                    type: 'story_mention',
                    storyId: storyRef.id,
                    message: `${userData?.username} mentioned you in their story.`,
                    read: false,
                    createdAt: admin.firestore.FieldValue.serverTimestamp()
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
    } catch (error: any) {
        logger.error("Error creating story record:", {
            error: error.message,
            code: error.code || 'N/A',
            name: error.name || 'Error',
            stack: error.stack || 'No stack trace available'
        });
        throw new HttpsError("internal", `Failed to save to database: ${error.message}`);
    }
});

export const deleteStory = onCall(FUNCTION_CONFIG, async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "User must be logged in.");
    }

    const { storyId } = request.data;
    if (!storyId) {
        throw new HttpsError("invalid-argument", "Story ID is required.");
    }

    try {
        const storyRef = db.collection("stories").doc(storyId);
        const storyDoc = await storyRef.get();

        if (!storyDoc.exists) {
            throw new HttpsError("not-found", "Story not found.");
        }

        const storyData = storyDoc.data();
        if (storyData?.userId !== request.auth.uid) {
            throw new HttpsError("permission-denied", "You can only delete your own stories.");
        }

        // Delete from S3 if mediaUrl exists
        if (storyData?.mediaUrl && S3_BUCKET) {
            try {
                // Extract Key from URL
                // Example URL: https://BUCKET.s3.REGION.amazonaws.com/stories/images/FILE.jpg
                const urlParts = storyData.mediaUrl.split('.amazonaws.com/');
                if (urlParts.length > 1) {
                    const fileKey = urlParts[1];
                    const command = new DeleteObjectCommand({
                        Bucket: S3_BUCKET,
                        Key: fileKey,
                    });
                    await s3Client.send(command);
                    logger.info(`Deleted S3 object: ${fileKey}`);
                }
            } catch (s3Error) {
                logger.error("Failed to delete from S3:", s3Error);
                // Continue to delete from DB even if S3 fails
            }
        }

        await storyRef.delete();
        logger.info(`Story ${storyId} deleted by user ${request.auth.uid}`);

        return { success: true };
    } catch (error: any) {
        logger.error("Error deleting story:", error);
        throw new HttpsError("internal", error.message);
    }
});

export const cleanupExpiredStories = functions.scheduler.onSchedule({
    schedule: "every 24 hours", // Daily cleanup is enough to save costs
    region: "us-central1", // Move to cheaper region
    cpu: 0.25,
    memory: "256MiB" as MemoryOption,
}, async (event) => {
    const now = admin.firestore.Timestamp.now();
    const storiesRef = db.collection("stories");
    const expiredStoriesQuery = storiesRef.where("expiresAt", "<=", now);

    const snapshot = await expiredStoriesQuery.get();
    
    if (snapshot.empty) {
        logger.info("No expired stories to delete.");
        return;
    }

    const batch = db.batch();
    snapshot.docs.forEach((doc: any) => {
      batch.delete(doc.ref);
      // Ideally we should also delete from S3 here, but batch doesn't support async/await well inside loop
      // For now we just clean DB. S3 lifecycle rules can handle file expiration.
    });

    await batch.commit();
    logger.info(`Deleted ${snapshot.size} expired stories.`);
});
