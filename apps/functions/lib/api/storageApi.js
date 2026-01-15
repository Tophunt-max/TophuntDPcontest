"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.storageApi = void 0;
const https_1 = require("firebase-functions/v2/https");
/**
 * Storage API (LEGACY)
 * This was previously using AWS SDK. Since we switched to Cloudflare Workers (R2),
 * we are disabling the AWS logic to fix deployment dependencies.
 */
const storageApi = async (request) => {
    // Return error or simple message since this is now handled by Cloudflare Workers
    throw new https_1.HttpsError("failed-precondition", "AWS Storage API is disabled. Please use Cloudflare Worker endpoints for uploads.");
};
exports.storageApi = storageApi;
//# sourceMappingURL=storageApi.js.map