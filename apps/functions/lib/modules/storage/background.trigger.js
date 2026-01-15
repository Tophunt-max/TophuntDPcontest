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
exports.onMediaJobCreated = void 0;
const logger = __importStar(require("firebase-functions/logger"));
const firestore_1 = require("firebase-functions/v2/firestore");
const image_processor_1 = require("./image.processor");
const video_processor_1 = require("./video.processor");
const storage_service_1 = require("./storage.service");
const admin = __importStar(require("firebase-admin"));
const db = admin.firestore();
const storageSecrets = ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_ACCOUNT_ID", "R2_BUCKET_NAME"];
exports.onMediaJobCreated = (0, firestore_1.onDocumentCreated)({
    document: "media_jobs/{jobId}",
    secrets: storageSecrets
}, async (event) => {
    const imageProcessor = new image_processor_1.ImageProcessor();
    const videoProcessor = new video_processor_1.VideoProcessor();
    const storageService = new storage_service_1.StorageService();
    const snapshot = event.data;
    if (!snapshot)
        return;
    const jobData = snapshot.data();
    const jobId = event.params.jobId;
    const { tempKey, destinationFolder, userId, fileType } = jobData;
    logger.info(`Processing Job ${jobId} for user ${userId} in folder ${destinationFolder}`);
    try {
        await snapshot.ref.update({ status: 'processing', startedAt: new Date() });
        let result;
        if (fileType === 'video') {
            result = await videoProcessor.processAndUpload(tempKey, destinationFolder, userId, jobId);
        }
        else {
            result = await imageProcessor.processAndUpload(tempKey, destinationFolder, userId, jobId);
        }
        // result contains { full: "...", medium: "...", thumb: "..." } with .webp extensions
        const finalUrl = result.full || result.medium;
        const tempPublicUrl = `https://media.tophunt.in/${tempKey}`;
        if (destinationFolder === 'profiles') {
            await db.collection('users').doc(userId).update({
                // FIX: Use the URL WITH extension from the result
                profileImageUrl: finalUrl,
                photoDerivatives: result
            });
        }
        else if (destinationFolder === 'posts' || destinationFolder === 'contest_entries') {
            const postsQuery = await db.collection('posts')
                .where('userId', '==', userId)
                .where('mediaUrl', '==', tempPublicUrl)
                .limit(1)
                .get();
            if (!postsQuery.empty) {
                await postsQuery.docs[0].ref.update({
                    mediaUrl: finalUrl,
                    mediaDerivatives: result,
                    status: 'active'
                });
            }
        }
        else if (destinationFolder === 'stories') {
            const storiesQuery = await db.collection('stories')
                .where('userId', '==', userId)
                .where('mediaUrl', '==', tempPublicUrl)
                .limit(1)
                .get();
            if (!storiesQuery.empty) {
                await storiesQuery.docs[0].ref.update({
                    mediaUrl: finalUrl,
                    mediaDerivatives: result
                });
            }
        }
        await storageService.deleteFile(tempKey);
        await snapshot.ref.update({
            status: 'completed',
            completedAt: new Date(),
            output: result
        });
    }
    catch (error) {
        logger.error(`Job ${jobId} Failed`, error);
        await snapshot.ref.update({
            status: 'failed',
            error: error.message
        });
    }
});
//# sourceMappingURL=background.trigger.js.map