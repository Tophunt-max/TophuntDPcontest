"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getCallCredentials = void 0;
const https_1 = require("firebase-functions/v2/https");
const firebase_functions_1 = require("firebase-functions");
const node_fetch_1 = __importDefault(require("node-fetch"));
const CLOUDFLARE_TURN_TOKEN_ID = "95758f1866d31bc04fbd2d33262b57ac";
const CLOUDFLARE_API_TOKEN = "5ee9c80a211e00de7c615700053ff1ad7b50f7a412454cd9015de8bb7b9fce5e";
const getCallCredentials = async (request) => {
    if (!request.auth) {
        throw new https_1.HttpsError("unauthenticated", "User must be logged in.");
    }
    try {
        const response = await (0, node_fetch_1.default)(`https://rtc.live.cloudflare.com/v1/turn/keys/${CLOUDFLARE_TURN_TOKEN_ID}/credentials`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${CLOUDFLARE_API_TOKEN}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                ttl: 86400 // 24 hours
            })
        });
        if (!response.ok) {
            const errorText = await response.text();
            firebase_functions_1.logger.error("Cloudflare TURN Error:", errorText);
            throw new https_1.HttpsError("internal", "Failed to fetch TURN credentials from Cloudflare.");
        }
        const data = await response.json();
        return data; // This matches the iceServers format Cloudflare returns
    }
    catch (error) {
        firebase_functions_1.logger.error("getCallCredentials Error:", error);
        throw new https_1.HttpsError("internal", error.message || "Internal server error.");
    }
};
exports.getCallCredentials = getCallCredentials;
//# sourceMappingURL=index.js.map