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
exports.createUserRecord = void 0;
const https_1 = require("firebase-functions/v2/https");
const logger = __importStar(require("firebase-functions/logger"));
const firebase_1 = require("../utils/firebase");
exports.createUserRecord = (0, https_1.onCall)({ region: "asia-south1", cors: true }, async (request) => {
    var _a;
    const uid = ((_a = request.auth) === null || _a === void 0 ? void 0 : _a.uid) || request.data.uid;
    if (!uid) {
        throw new https_1.HttpsError("unauthenticated", "User must be authenticated to create a profile.");
    }
    const { email, username, fullName, avatarUrl, dob, phone, occupation, gender, following, platform // Added platform field
     } = request.data;
    try {
        await firebase_1.db.collection("users").doc(uid).set({
            uid: uid,
            email: email || null,
            username: username || null,
            fullName: fullName || null,
            profileImageUrl: avatarUrl || null,
            dob: dob || null,
            phone: phone || null,
            occupation: occupation || null,
            gender: gender || null,
            following: following || [],
            platform: platform || "unknown", // Save platform info
            createdAt: firebase_1.admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: firebase_1.admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
        return { success: true };
    }
    catch (error) {
        logger.error("Error creating user record:", error);
        throw new https_1.HttpsError("internal", "Could not create user record.");
    }
});
//# sourceMappingURL=createUserRecord.js.map