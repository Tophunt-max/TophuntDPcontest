import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { v4 as uuidv4 } from "uuid";
import * as dotenv from 'dotenv';
import { MemoryOption } from "firebase-functions/v2/options";
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

const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp", "video/mp4", "video/quicktime"];

const getExtension = (mimeType: string): string => {
    switch (mimeType) {
        case "image/jpeg": return ".jpg";
        case "image/png": return ".png";
        case "image/gif": return ".gif";
        case "image/webp": return ".webp";
        case "video/mp4": return ".mp4";
        case "video/quicktime": return ".mov";
        default: return "";
    }
};

const STORAGE_CONFIG = {
    region: "us-central1",
    cpu: 1, // Increased to 1
    concurrency: 80,
    memory: "256MiB" as MemoryOption,
    maxInstances: 2,
    cors: true
};

export const generatePresignedUrl = onCall(STORAGE_CONFIG, async (request) => {
    const { fileType, folder } = request.data;
    
    if (!fileType || !folder) {
        throw new HttpsError("invalid-argument", "fileType and folder are required.");
    }

    logger.info("Generating Presigned URL", { fileType, folder });

    if (!ALLOWED_MIME_TYPES.includes(fileType)) {
        throw new HttpsError("invalid-argument", "Invalid file type.");
    }
    
    if (!S3_BUCKET || !S3_REGION || !S3_ACCESS_KEY || !S3_SECRET_KEY) {
        logger.error("Missing S3 configuration");
        throw new HttpsError("internal", "Server configuration error.");
    }

    const subFolder = fileType.startsWith('video/') ? "videos" : "images";
    const extension = getExtension(fileType);
    const fileKey = `${folder}/${subFolder}/${uuidv4()}${extension}`;
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
        logger.error("Error generating presigned URL:", error);
        throw new HttpsError("internal", "Could not generate upload URL.");
    }
});
