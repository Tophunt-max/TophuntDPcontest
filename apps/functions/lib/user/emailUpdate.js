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
exports.verifyEmailUpdateOtp = exports.sendEmailUpdateOtp = void 0;
const https_1 = require("firebase-functions/v2/https");
const logger = __importStar(require("firebase-functions/logger"));
const firebase_1 = require("../utils/firebase");
const nodemailer = __importStar(require("nodemailer"));
// Configure your email transporter
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
});
exports.sendEmailUpdateOtp = (0, https_1.onCall)({ region: "asia-south1", cors: true }, async (request) => {
    if (!request.auth) {
        throw new https_1.HttpsError("unauthenticated", "User must be logged in.");
    }
    const { newEmail } = request.data;
    if (!newEmail) {
        throw new https_1.HttpsError("invalid-argument", "New email is required.");
    }
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes
    try {
        // Save OTP to Firestore
        await firebase_1.db.collection("emailUpdateOtps").doc(request.auth.uid).set({
            newEmail,
            otp,
            expiresAt,
        });
        // Send Email
        const mailOptions = {
            from: `"Instagram DP" <${process.env.EMAIL_USER}>`,
            to: newEmail,
            subject: "Verify your new email address",
            text: `Your OTP for email update is: ${otp}. It will expire in 10 minutes.`,
            html: `<h3>Email Verification</h3><p>Your OTP for updating your email address is: <b>${otp}</b></p><p>It will expire in 10 minutes.</p>`,
        };
        await transporter.sendMail(mailOptions);
        return { success: true };
    }
    catch (error) {
        logger.error("Error sending email update OTP:", error);
        throw new https_1.HttpsError("internal", "Could not send OTP. " + error.message);
    }
});
exports.verifyEmailUpdateOtp = (0, https_1.onCall)({ region: "asia-south1", cors: true }, async (request) => {
    if (!request.auth) {
        throw new https_1.HttpsError("unauthenticated", "User must be logged in.");
    }
    const { otp } = request.data;
    if (!otp) {
        throw new https_1.HttpsError("invalid-argument", "OTP is required.");
    }
    const userId = request.auth.uid;
    const otpDocRef = firebase_1.db.collection("emailUpdateOtps").doc(userId);
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
    const newEmail = data === null || data === void 0 ? void 0 : data.newEmail;
    try {
        // Update Auth Email
        await firebase_1.admin.auth().updateUser(userId, {
            email: newEmail,
        });
        // Update Firestore User Email
        await firebase_1.db.collection("users").doc(userId).update({
            email: newEmail,
            updatedAt: firebase_1.admin.firestore.FieldValue.serverTimestamp(),
        });
        // Delete OTP record
        await otpDocRef.delete();
        return { success: true, email: newEmail };
    }
    catch (error) {
        logger.error("Error updating email:", error);
        throw new https_1.HttpsError("internal", "Could not update email. " + error.message);
    }
});
//# sourceMappingURL=emailUpdate.js.map