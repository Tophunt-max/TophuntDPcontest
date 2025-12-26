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
exports.getUserByIdentifier = void 0;
const https_1 = require("firebase-functions/v2/https");
const logger = __importStar(require("firebase-functions/logger"));
const firebase_1 = require("../utils/firebase");
exports.getUserByIdentifier = (0, https_1.onCall)({ region: "asia-south1", cors: true }, async (request) => {
    const { identifier, type } = request.data; // type: 'email' or 'phone'
    if (!identifier || !type) {
        throw new https_1.HttpsError("invalid-argument", "Identifier and type are required.");
    }
    logger.info(`Searching for user by ${type}: ${identifier}`);
    try {
        let querySnapshot;
        if (type === 'email') {
            querySnapshot = await firebase_1.db.collection("users").where("email", "==", identifier.trim()).limit(1).get();
        }
        else if (type === 'phone') {
            // Try matching with and without '+' or spaces, just in case
            // But strict match is better. Assuming client sends clean phone.
            querySnapshot = await firebase_1.db.collection("users").where("phone", "==", identifier.trim()).limit(1).get();
        }
        else {
            throw new https_1.HttpsError("invalid-argument", "Invalid type. Must be 'email' or 'phone'.");
        }
        if (querySnapshot.empty) {
            logger.warn(`User NOT found for ${type}: ${identifier}`);
            // Debugging: Log all users (limit 5) to see format
            // const debugSnap = await db.collection("users").limit(5).get();
            // debugSnap.forEach(doc => logger.info(`Existing user: ${doc.id} => email: ${doc.data().email}, phone: ${doc.data().phone}`));
            return { found: false };
        }
        const userData = querySnapshot.docs[0].data();
        logger.info(`User found: ${userData.uid} / ${userData.email}`);
        // Return only necessary public info to confirm identity
        return {
            found: true,
            user: {
                name: userData.fullName || "User",
                username: userData.username || "",
                avatar: userData.profileImageUrl || null
            }
        };
    }
    catch (error) {
        logger.error("Error fetching user:", error);
        throw new https_1.HttpsError("internal", "Could not fetch user details: " + error.message);
    }
});
//# sourceMappingURL=getUserByIdentifier.js.map