import { HttpsError, CallableRequest } from "firebase-functions/v2/https";

/**
 * Storage API (LEGACY)
 * This was previously using AWS SDK. Since we switched to Cloudflare Workers (R2), 
 * we are disabling the AWS logic to fix deployment dependencies.
 */
export const storageApi = async (request: CallableRequest) => {
    // Return error or simple message since this is now handled by Cloudflare Workers
    throw new HttpsError(
        "failed-precondition", 
        "AWS Storage API is disabled. Please use Cloudflare Worker endpoints for uploads."
    );
};
