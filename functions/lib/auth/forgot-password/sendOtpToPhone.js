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
exports.sendOtpToPhone = void 0;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const node_fetch_1 = __importDefault(require("node-fetch"));
const crypto = __importStar(require("crypto"));
const db = admin.firestore();
const SMS_API_URL = process.env.SMS_API_URL;
const SMS_API_KEY = process.env.SMS_API_KEY;
const OTP_EXPIRY_MIN = 5;
function generateOtp() {
    return Math.floor(1000 + Math.random() * 9000).toString();
}
exports.sendOtpToPhone = functions.https.onCall(async (data) => {
    const { phoneNumber } = data;
    if (!phoneNumber) {
        throw new functions.https.HttpsError("invalid-argument", "Phone required");
    }
    const otp = generateOtp();
    const hash = crypto.createHash("sha256").update(otp).digest("hex");
    await db.collection("passwordResetOtps").doc(phoneNumber).set({
        hash,
        attempts: 0,
        expiresAt: admin.firestore.Timestamp.fromDate(new Date(Date.now() + OTP_EXPIRY_MIN * 60 * 1000)),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    const message = `Your OTP is ${otp}. Valid for ${OTP_EXPIRY_MIN} minutes.`;
    await (0, node_fetch_1.default)(SMS_API_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${SMS_API_KEY}`,
        },
        body: JSON.stringify({
            to: phoneNumber,
            message,
        }),
    });
    return { success: true };
});
//# sourceMappingURL=sendOtpToPhone.js.map