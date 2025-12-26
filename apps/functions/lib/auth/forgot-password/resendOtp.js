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
exports.resendOtp = void 0;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const twilio_1 = require("twilio");
const twilioClient = new twilio_1.Twilio(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);
const twilioFromNumber = process.env.TWILIO_FROM;
exports.resendOtp = functions.https.onCall(async (data, context) => {
    const { phoneNumber } = data;
    if (!phoneNumber) {
        throw new functions.https.HttpsError('invalid-argument', 'Phone number is required.');
    }
    const otpRef = admin.firestore().collection('otps').doc(phoneNumber);
    const newOtp = Math.floor(1000 + Math.random() * 9000).toString();
    const expires = admin.firestore.Timestamp.now().toMillis() + 5 * 60 * 1000;
    await twilioClient.messages.create({
        body: `Your new verification code is: ${newOtp}`,
        to: phoneNumber,
        from: twilioFromNumber,
    });
    await otpRef.set({
        otp: newOtp,
        expires,
        attempts: 0,
        verified: false
    }, { merge: true });
    return { success: true, message: 'New OTP sent.' };
});
//# sourceMappingURL=resendOtp.js.map