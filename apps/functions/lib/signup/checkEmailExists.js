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
exports.checkEmailExists = void 0;
const https_1 = require("firebase-functions/v2/https");
const logger = __importStar(require("firebase-functions/logger"));
const firebase_1 = require("../utils/firebase");
exports.checkEmailExists = (0, https_1.onCall)({ region: "asia-south1", cors: true }, async (request) => {
    var _a, _b;
    if (!request.data || !request.data.email) {
        throw new https_1.HttpsError("invalid-argument", "The function must be called with an email.");
    }
    const email = request.data.email.trim();
    logger.info(`Request from user: ${(_a = request.auth) === null || _a === void 0 ? void 0 : _a.uid}, app: ${(_b = request.app) === null || _b === void 0 ? void 0 : _b.appId}`);
    logger.info(`Checking for email: ${email}`);
    try {
        const snapshot = await firebase_1.db.collection("users").where("email", "==", email).get();
        const exists = !snapshot.empty;
        logger.info(`Email '${email}' exists: ${exists}`);
        return { exists: exists };
    }
    catch (error) {
        logger.error("Error checking email:", error);
        throw new https_1.HttpsError("internal", "Could not check email existence. Internal error: " + error.message);
    }
});
//# sourceMappingURL=checkEmailExists.js.map