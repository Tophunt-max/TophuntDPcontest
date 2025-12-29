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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyPhoneUpdateOtp = exports.sendPhoneUpdateOtp = void 0;
const https_1 = require("firebase-functions/v2/https");
const logger = __importStar(require("firebase-functions/logger"));
const firebase_1 = require("../utils/firebase");
const twilio_1 = __importDefault(require("twilio"));
// Configure Twilio (Make sure these are in your .env)
// Lazy initialization to prevent deployment errors if env vars are missing locally
let twilioClient = null;
const getTwilioClient = () => {
    if (!twilioClient) {
        // Fallback or error if env vars missing, but only at runtime
        const sid = process.env.TWILIO_ACCOUNT_SID;
        const token = process.env.TWILIO_AUTH_TOKEN;
        if (!sid || !token) {
            throw new Error("Twilio credentials missing in environment variables.");
        }
        twilioClient = (0, twilio_1.default)(sid, token);
    }
    return twilioClient;
};
exports.sendPhoneUpdateOtp = (0, https_1.onCall)({ region: "asia-south1", cors: true }, async (request) => {
    if (!request.auth) {
        throw new https_1.HttpsError("unauthenticated", "User must be logged in.");
    }
    const { newPhone } = request.data;
    if (!newPhone) {
        throw new https_1.HttpsError("invalid-argument", "New phone number is required.");
    }
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes
    try {
        // Save OTP to Firestore
        await firebase_1.db.collection("phoneUpdateOtps").doc(request.auth.uid).set({
            newPhone,
            otp,
            expiresAt,
        });
        // Send SMS via Twilio
        await getTwilioClient().messages.create({
            body: `Your Instagram DP OTP for phone number update is: ${otp}. Valid for 10 minutes.`,
            from: process.env.TWILIO_PHONE_NUMBER,
            to: newPhone,
        });
        return { success: true };
    }
    catch (error) {
        logger.error("Error sending phone update OTP:", error);
        throw new https_1.HttpsError("internal", "Could not send SMS. " + error.message);
    }
});
exports.verifyPhoneUpdateOtp = (0, https_1.onCall)({ region: "asia-south1", cors: true }, async (request) => {
    if (!request.auth) {
        throw new https_1.HttpsError("unauthenticated", "User must be logged in.");
    }
    const { otp } = request.data;
    if (!otp) {
        throw new https_1.HttpsError("invalid-argument", "OTP is required.");
    }
    const userId = request.auth.uid;
    const otpDocRef = firebase_1.db.collection("phoneUpdateOtps").doc(userId);
    const otpDoc = await otpDocRef.get();
    if (!otpDoc.exists) {
        throw new https_1.HttpsError("not-found", "No OTP request found.");
    }
    const data = otpDoc.data();
    if ((data === null || data === void 0 ? void 0 : data.otp) !== otp) {
        throw new https_1.HttpsError("invalid-argument", "Incorrect OTP.");
    }
    if (Date.now() > (data === null || data === void 0 ? void 0 : data.expiresAt)) {
        throw new https_1.HttpsError("deadline-exceeded", "OTP has expired.");
    }
    const newPhone = data === null || data === void 0 ? void 0 : data.newPhone;
    try {
        // Update Firestore User Phone (Firebase Auth doesn't store phone in basic profile usually, it's a separate MFA field)
        await firebase_1.db.collection("users").doc(userId).update({
            phone: newPhone,
            updatedAt: firebase_1.admin.firestore.FieldValue.serverTimestamp(),
        });
        // Delete OTP record
        await otpDocRef.delete();
        return { success: true, phone: newPhone };
    }
    catch (error) {
        logger.error("Error updating phone:", error);
        throw new https_1.HttpsError("internal", "Could not update phone number. " + error.message);
    }
});
//# sourceMappingURL=phoneUpdate.js.map