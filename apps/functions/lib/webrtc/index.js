"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getCallCredentials = void 0;
const https_1 = require("firebase-functions/v2/https");
const firebase_functions_1 = require("firebase-functions");
const CLOUDFLARE_TURN_TOKEN_ID = "95758f1866d31bc04fbd2d33262b57ac";
const CLOUDFLARE_API_TOKEN = "5ee9c80a211e00de7c615700053ff1ad7b50f7a412454cd9015de8bb7b9fce5e";
const getCallCredentials = async (request) => {
    if (!request.auth) {
        throw new https_1.HttpsError("unauthenticated", "User must be logged in.");
    }
    try {
        // Use Node 20's native fetch
        const response = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${CLOUDFLARE_TURN_TOKEN_ID}/credentials`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${CLOUDFLARE_API_TOKEN}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                ttl: 86400 // 24 hours
            })
        });
        const responseData = await response.json();
        if (!response.ok) {
            firebase_functions_1.logger.error("Cloudflare TURN API Error Details:", {
                status: response.status,
                statusText: response.statusText,
                error: responseData
            });
            // Agar credentials endpoint fail hota hai, toh bina /credentials ke try karte hain (Fallback)
            if (response.status === 404) {
                firebase_functions_1.logger.info("Retrying without /credentials suffix...");
                const retryResponse = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${CLOUDFLARE_TURN_TOKEN_ID}`, {
                    method: "POST",
                    headers: {
                        "Authorization": `Bearer ${CLOUDFLARE_API_TOKEN}`,
                        "Content-Type": "application/json"
                    }
                });
                if (retryResponse.ok)
                    return await retryResponse.json();
            }
            throw new https_1.HttpsError("internal", `Cloudflare Error: ${response.status} - ${JSON.stringify(responseData)}`);
        }
        return responseData;
    }
    catch (error) {
        firebase_functions_1.logger.error("getCallCredentials Catch Error:", error);
        if (error instanceof https_1.HttpsError)
            throw error;
        throw new https_1.HttpsError("internal", error.message || "Internal server error.");
    }
};
exports.getCallCredentials = getCallCredentials;
//# sourceMappingURL=index.js.map