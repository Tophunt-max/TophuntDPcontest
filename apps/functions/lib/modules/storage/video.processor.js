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
exports.VideoProcessor = void 0;
const client_s3_1 = require("@aws-sdk/client-s3");
const storage_service_1 = require("./storage.service");
const uuid_1 = require("uuid");
const os = __importStar(require("os"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const child_process_1 = require("child_process");
const CDN_URL = "https://media.tophunt.in";
class VideoProcessor {
    constructor() {
        this.storage = new storage_service_1.StorageService();
    }
    async processAndUpload(tempKey, folder, userId, customId) {
        const client = this.storage.getS3Client();
        const bucket = this.storage.getBucketName();
        // 1. Download only the first few MBs for thumbnail (Memory optimization)
        // For now, downloading the whole file since it's already compressed by client
        const original = await client.send(new client_s3_1.GetObjectCommand({ Bucket: bucket, Key: tempKey }));
        const tempFilePath = path.join(os.tmpdir(), `${(0, uuid_1.v4)()}.mp4`);
        const stream = original.Body;
        const writeStream = fs.createWriteStream(tempFilePath);
        await new Promise((resolve, reject) => {
            stream.pipe(writeStream);
            stream.on("error", reject);
            writeStream.on("finish", () => { resolve(); });
        });
        const fileId = customId || (0, uuid_1.v4)();
        const basePath = `${folder}/${userId}/${fileId}`;
        const videoKey = `${basePath}.mp4`;
        const thumbKey = `${basePath}_thumb.webp`;
        try {
            // 2. FAST Thumbnail Generation (No heavy re-encoding)
            const thumbPath = path.join(os.tmpdir(), `${fileId}_thumb.webp`);
            await new Promise((resolve, reject) => {
                const ffmpeg = (0, child_process_1.spawn)('ffmpeg', [
                    '-ss', '00:00:01', // Start at 1 second
                    '-i', tempFilePath,
                    '-vframes', '1',
                    '-vf', 'scale=480:-1',
                    '-c:v', 'webp',
                    '-q:v', '50', // Medium quality for thumb
                    thumbPath
                ]);
                ffmpeg.on('close', (code) => {
                    if (code === 0)
                        resolve();
                    else
                        reject(new Error(`FFmpeg failed with code ${code}`));
                });
                ffmpeg.on('error', (err) => reject(err));
            });
            // 3. Upload Thumbnail
            const thumbBuffer = fs.readFileSync(thumbPath);
            await client.send(new client_s3_1.PutObjectCommand({
                Bucket: bucket, Key: thumbKey, Body: thumbBuffer,
                ContentType: "image/webp", Metadata: { userId }
            }));
            // 4. MOVE Video instead of Re-uploading (R2 internal move - Zero Bandwidth/CPU cost)
            // Since client already compressed it, we just move it to permanent location
            await client.send(new client_s3_1.CopyObjectCommand({
                Bucket: bucket,
                CopySource: `${bucket}/${tempKey}`,
                Key: videoKey,
                ContentType: "video/mp4",
                MetadataDirective: "REPLACE",
                Metadata: { userId, processed: "true" }
            }));
            // Cleanup local temp files
            if (fs.existsSync(tempFilePath))
                fs.unlinkSync(tempFilePath);
            if (fs.existsSync(thumbPath))
                fs.unlinkSync(thumbPath);
            return {
                video: `${CDN_URL}/${videoKey}`,
                thumbnail: `${CDN_URL}/${thumbKey}`
            };
        }
        catch (error) {
            console.error("Video Processing Error:", error);
            if (fs.existsSync(tempFilePath))
                try {
                    fs.unlinkSync(tempFilePath);
                }
                catch (e) { }
            throw error;
        }
    }
}
exports.VideoProcessor = VideoProcessor;
//# sourceMappingURL=video.processor.js.map