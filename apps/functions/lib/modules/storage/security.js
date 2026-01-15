"use strict";
var __asyncValues = (this && this.__asyncValues) || function (o) {
    if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
    var m = o[Symbol.asyncIterator], i;
    return m ? m.call(o) : (o = typeof __values === "function" ? __values(o) : o[Symbol.iterator](), i = {}, verb("next"), verb("throw"), verb("return"), i[Symbol.asyncIterator] = function () { return this; }, i);
    function verb(n) { i[n] = o[n] && function (v) { return new Promise(function (resolve, reject) { v = o[n](v), settle(resolve, reject, v.done, v.value); }); }; }
    function settle(resolve, reject, d, v) { Promise.resolve(v).then(function(v) { resolve({ value: v, done: d }); }, reject); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.StorageSecurity = void 0;
const client_s3_1 = require("@aws-sdk/client-s3"); // Added HeadObjectCommand
const storage_service_1 = require("./storage.service");
const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20MB
const MAX_VIDEO_SIZE = 500 * 1024 * 1024; // 500MB (Increased for multipart)
const ALLOWED_FOLDERS = ["profiles", "stories", "banners", "posts", "contest_entries", "admin-uploads"];
class StorageSecurity {
    constructor() {
        this.storage = new storage_service_1.StorageService();
    }
    validateUploadRequest(folder, fileSize, fileType) {
        if (!ALLOWED_FOLDERS.includes(folder)) {
            throw new Error(`Invalid upload folder: ${folder}`);
        }
        const limit = fileType.startsWith('video') ? MAX_VIDEO_SIZE : MAX_IMAGE_SIZE;
        if (fileSize && fileSize > limit) {
            throw new Error(`File too large. Limit is ${limit / 1024 / 1024}MB.`);
        }
    }
    async verifyFileOwnership(key, userId) {
        var _a, _b;
        const client = this.storage.getS3Client();
        const bucket = this.storage.getBucketName();
        const head = await client.send(new client_s3_1.HeadObjectCommand({ Bucket: bucket, Key: key }));
        // S3 Metadata keys are often lowercased
        const owner = ((_a = head.Metadata) === null || _a === void 0 ? void 0 : _a.userid) || ((_b = head.Metadata) === null || _b === void 0 ? void 0 : _b.userId);
        if (owner && owner !== userId) {
            throw new Error("Security Violation: File does not belong to user.");
        }
    }
    async validateFileIntegrity(key, expectedType = 'image') {
        var _a, e_1, _b, _c;
        const client = this.storage.getS3Client();
        const bucket = this.storage.getBucketName();
        const response = await client.send(new client_s3_1.GetObjectCommand({
            Bucket: bucket, Key: key, Range: "bytes=0-15"
        }));
        if (!response.Body)
            throw new Error("Empty file.");
        const stream = response.Body;
        const chunks = [];
        try {
            for (var _d = true, stream_1 = __asyncValues(stream), stream_1_1; stream_1_1 = await stream_1.next(), _a = stream_1_1.done, !_a; _d = true) {
                _c = stream_1_1.value;
                _d = false;
                const chunk = _c;
                chunks.push(chunk);
            }
        }
        catch (e_1_1) { e_1 = { error: e_1_1 }; }
        finally {
            try {
                if (!_d && !_a && (_b = stream_1.return)) await _b.call(stream_1);
            }
            finally { if (e_1) throw e_1.error; }
        }
        const hex = Buffer.concat(chunks).toString('hex').toUpperCase();
        if (expectedType === 'image') {
            const isWebP = hex.startsWith("52494646") && hex.includes("57454250");
            const isJPEG = hex.startsWith("FFD8FF");
            const isPNG = hex.startsWith("89504E47");
            if (!isWebP && !isJPEG && !isPNG)
                throw new Error("Invalid Image Signature");
        }
        else if (expectedType === 'video') {
            // Simple MP4/MOV check
            const isMP4 = hex.includes("66747970"); // 'ftyp'
            if (!isMP4)
                throw new Error("Invalid Video Signature (Only MP4/MOV supported)");
        }
    }
}
exports.StorageSecurity = StorageSecurity;
//# sourceMappingURL=security.js.map