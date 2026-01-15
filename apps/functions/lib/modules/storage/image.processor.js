"use strict";
var __asyncValues = (this && this.__asyncValues) || function (o) {
    if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
    var m = o[Symbol.asyncIterator], i;
    return m ? m.call(o) : (o = typeof __values === "function" ? __values(o) : o[Symbol.iterator](), i = {}, verb("next"), verb("throw"), verb("return"), i[Symbol.asyncIterator] = function () { return this; }, i);
    function verb(n) { i[n] = o[n] && function (v) { return new Promise(function (resolve, reject) { v = o[n](v), settle(resolve, reject, v.done, v.value); }); }; }
    function settle(resolve, reject, d, v) { Promise.resolve(v).then(function(v) { resolve({ value: v, done: d }); }, reject); }
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ImageProcessor = void 0;
const client_s3_1 = require("@aws-sdk/client-s3");
const sharp_1 = __importDefault(require("sharp"));
const storage_service_1 = require("./storage.service");
const uuid_1 = require("uuid");
const CDN_URL = "https://media.tophunt.in";
class ImageProcessor {
    constructor() {
        this.storage = new storage_service_1.StorageService();
    }
    async processAndUpload(tempKey, folder, userId, customId) {
        var _a, e_1, _b, _c;
        const client = this.storage.getS3Client();
        const bucket = this.storage.getBucketName();
        // 1. Download Temp File
        const original = await client.send(new client_s3_1.GetObjectCommand({ Bucket: bucket, Key: tempKey }));
        const stream = original.Body;
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
        const buffer = Buffer.concat(chunks);
        // 2. Define Output Paths
        const fileId = customId || (0, uuid_1.v4)();
        // Path structure: profiles/userId/jobId.webp
        const basePath = `${folder}/${userId}/${fileId}`;
        const sizes = [
            { suffix: 'thumb', width: 200 },
            { suffix: 'medium', width: 600 },
            { suffix: 'full', width: 1080 }
        ];
        // 3. Process & Upload Variants
        const uploadPromises = sizes.map(async (size) => {
            const resizedBuffer = await (0, sharp_1.default)(buffer)
                .resize(size.width, null, { withoutEnlargement: true })
                .webp({ quality: 80 })
                .toBuffer();
            // ALWAYS append .webp extension
            const key = size.suffix === 'full'
                ? `${basePath}.webp`
                : `${basePath}_${size.suffix}.webp`;
            await client.send(new client_s3_1.PutObjectCommand({
                Bucket: bucket,
                Key: key,
                Body: resizedBuffer,
                ContentType: "image/webp", // FORCE image/webp
                CacheControl: "public, max-age=31536000, immutable",
                Metadata: {
                    userId,
                    "Content-Type": "image/webp" // Double insurance for R2
                }
            }));
            return {
                variant: size.suffix,
                url: `${CDN_URL}/${key}`
            };
        });
        const results = await Promise.all(uploadPromises);
        return results.reduce((acc, curr) => {
            acc[curr.variant] = curr.url;
            return acc;
        }, {});
    }
}
exports.ImageProcessor = ImageProcessor;
//# sourceMappingURL=image.processor.js.map