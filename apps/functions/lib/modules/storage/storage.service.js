"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StorageService = void 0;
const client_s3_1 = require("@aws-sdk/client-s3");
const s3_request_presigner_1 = require("@aws-sdk/s3-request-presigner");
const params_1 = require("firebase-functions/params");
const uuid_1 = require("uuid");
const R2_ACCESS_KEY_ID = (0, params_1.defineSecret)("R2_ACCESS_KEY_ID");
const R2_SECRET_ACCESS_KEY = (0, params_1.defineSecret)("R2_SECRET_ACCESS_KEY");
const R2_ACCOUNT_ID = (0, params_1.defineSecret)("R2_ACCOUNT_ID");
const R2_BUCKET_NAME = (0, params_1.defineSecret)("R2_BUCKET_NAME");
class StorageService {
    constructor() {
        this.client = null;
        this.bucket = "";
    }
    init() {
        if (!this.client) {
            // Sanitize values by trimming whitespace/newlines
            const accessKey = R2_ACCESS_KEY_ID.value().trim();
            const secretKey = R2_SECRET_ACCESS_KEY.value().trim();
            const accountId = R2_ACCOUNT_ID.value().trim();
            const bucketName = R2_BUCKET_NAME.value().trim();
            this.client = new client_s3_1.S3Client({
                region: "auto",
                endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
                credentials: {
                    accessKeyId: accessKey,
                    secretAccessKey: secretKey,
                },
            });
            this.bucket = bucketName;
        }
        return { client: this.client, bucket: this.bucket };
    }
    getS3Client() {
        return this.init().client;
    }
    getBucketName() {
        return this.init().bucket;
    }
    async uploadDirect(userId, folder, base64Data, mimeType) {
        const { client, bucket } = this.init();
        const fileId = (0, uuid_1.v4)();
        const ext = mimeType.split('/')[1] || 'webp';
        const key = `temp/${userId}/${fileId}.${ext}`;
        const buffer = Buffer.from(base64Data.replace(/^data:image\/\w+;base64,/, ""), 'base64');
        const command = new client_s3_1.PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: buffer,
            ContentType: mimeType,
            Metadata: {
                userid: userId
            }
        });
        await client.send(command);
        return {
            key,
            publicUrl: `https://media.tophunt.in/${key}`
        };
    }
    async generateUploadUrl(userId, folder, mimeType) {
        const { client, bucket } = this.init();
        const fileId = (0, uuid_1.v4)();
        const ext = mimeType.includes('video') ? 'mp4' : 'webp';
        const key = `temp/${userId}/${fileId}.${ext}`;
        const command = new client_s3_1.PutObjectCommand({
            Bucket: bucket,
            Key: key,
            ContentType: mimeType,
            Metadata: {
                userid: userId
            }
        });
        const url = await (0, s3_request_presigner_1.getSignedUrl)(client, command, { expiresIn: 600 });
        return {
            uploadUrl: url,
            key,
            tempId: fileId,
            publicUrl: `https://media.tophunt.in/${key}`
        };
    }
    async startMultipartUpload(userId, folder, mimeType) {
        const { client, bucket } = this.init();
        const fileId = (0, uuid_1.v4)();
        const ext = mimeType.includes('video') ? 'mp4' : 'dat';
        const key = `temp/${userId}/${fileId}.${ext}`;
        const command = new client_s3_1.CreateMultipartUploadCommand({
            Bucket: bucket,
            Key: key,
            ContentType: mimeType,
            Metadata: {
                userid: userId
            }
        });
        const { UploadId } = await client.send(command);
        return { uploadId: UploadId, key, tempId: fileId };
    }
    async getMultipartUrls(key, uploadId, parts) {
        const { client, bucket } = this.init();
        const promises = [];
        for (let i = 1; i <= parts; i++) {
            const command = new client_s3_1.UploadPartCommand({
                Bucket: bucket,
                Key: key,
                UploadId: uploadId,
                PartNumber: i,
            });
            promises.push((0, s3_request_presigner_1.getSignedUrl)(client, command, { expiresIn: 3600 }));
        }
        return Promise.all(promises);
    }
    async completeMultipartUpload(key, uploadId, parts) {
        const { client, bucket } = this.init();
        const command = new client_s3_1.CompleteMultipartUploadCommand({
            Bucket: bucket,
            Key: key,
            UploadId: uploadId,
            MultipartUpload: { Parts: parts }
        });
        await client.send(command);
    }
    async deleteFile(key) {
        const { client, bucket } = this.init();
        await client.send(new client_s3_1.DeleteObjectCommand({ Bucket: bucket, Key: key }));
    }
}
exports.StorageService = StorageService;
//# sourceMappingURL=storage.service.js.map