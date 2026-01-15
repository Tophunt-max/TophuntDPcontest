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
exports.storageController = void 0;
const https_1 = require("firebase-functions/v2/https");
const logger = __importStar(require("firebase-functions/logger"));
const storage_service_1 = require("./storage.service");
const security_1 = require("./security");
const admin = __importStar(require("firebase-admin"));
const db = admin.firestore();
const storageController = async (request) => {
    var _a;
    const storageService = new storage_service_1.StorageService();
    const storageSecurity = new security_1.StorageSecurity();
    const payload = request.data.data || request.data;
    const action = request.data.action || payload.action;
    const userId = ((_a = request.auth) === null || _a === void 0 ? void 0 : _a.uid) || "guest";
    logger.info(`Storage Action: ${action}`, { userId, folder: payload.folder });
    try {
        switch (action) {
            case "uploadDirect": {
                const { folder, base64Data, mimeType } = payload;
                // Validation
                storageSecurity.validateUploadRequest(folder, (base64Data.length * 0.75), mimeType);
                if (base64Data.length > 10 * 1024 * 1024) { // Roughly 7.5MB decoded
                    throw new https_1.HttpsError("invalid-argument", "File too large for direct proxy. Use getUploadUrl instead.");
                }
                return await storageService.uploadDirect(userId, folder, base64Data, mimeType);
            }
            case "getPresignedUrl":
            case "getUploadUrl": {
                const { folder, fileSize, fileType = 'image/webp' } = payload;
                storageSecurity.validateUploadRequest(folder, fileSize, fileType);
                return await storageService.generateUploadUrl(userId, folder, fileType);
            }
            case "startMultipart": {
                const { folder, fileSize, fileType } = payload;
                storageSecurity.validateUploadRequest(folder, fileSize, fileType);
                return await storageService.startMultipartUpload(userId, folder, fileType);
            }
            case "getPartUrls": {
                const { key, uploadId, partCount } = payload;
                if (!key || !uploadId || !partCount)
                    throw new https_1.HttpsError("invalid-argument", "Missing multipart params");
                const urls = await storageService.getMultipartUrls(key, uploadId, partCount);
                return { urls };
            }
            case "completeMultipart": {
                const { key, uploadId, parts } = payload;
                await storageService.completeMultipartUpload(key, uploadId, parts);
                return { success: true };
            }
            case "finalizeUpload": {
                const { tempKey, destinationFolder, customId, fileType = 'image' } = payload;
                // Security checks
                if (userId !== "guest") {
                    await storageSecurity.verifyFileOwnership(tempKey, userId);
                }
                if (fileType !== 'video') {
                    await storageSecurity.validateFileIntegrity(tempKey, fileType);
                }
                const jobId = customId || db.collection('media_jobs').doc().id;
                const publicUrl = `https://media.tophunt.in/${tempKey}`;
                await db.collection('media_jobs').doc(jobId).set({
                    status: 'pending',
                    userId,
                    tempKey,
                    destinationFolder,
                    fileType,
                    createdAt: admin.firestore.FieldValue.serverTimestamp()
                });
                return {
                    success: true,
                    status: 'processing',
                    jobId,
                    previewUrl: publicUrl,
                    files: {
                        full: publicUrl,
                        medium: publicUrl,
                        thumb: publicUrl
                    }
                };
            }
            default:
                throw new https_1.HttpsError("invalid-argument", `Unknown action: ${action}`);
        }
    }
    catch (error) {
        logger.error("Storage Error", error);
        if (error instanceof https_1.HttpsError)
            throw error;
        throw new https_1.HttpsError("internal", error.message || "Internal Server Error");
    }
};
exports.storageController = storageController;
//# sourceMappingURL=storage.controller.js.map