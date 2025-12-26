import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { db, admin } from "../utils/firebase";
import twilio from "twilio";

// Configure Twilio (Make sure these are in your .env)
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

export const sendPhoneUpdateOtp = onCall({ region: "asia-south1", cors: true }, async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "User must be logged in.");
    }

    const { newPhone } = request.data;
    if (!newPhone) {
        throw new HttpsError("invalid-argument", "New phone number is required.");
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

    try {
        // Save OTP to Firestore
        await db.collection("phoneUpdateOtps").doc(request.auth.uid).set({
            newPhone,
            otp,
            expiresAt,
        });

        // Send SMS via Twilio
        await twilioClient.messages.create({
            body: `Your Instagram DP OTP for phone number update is: ${otp}. Valid for 10 minutes.`,
            from: process.env.TWILIO_PHONE_NUMBER,
            to: newPhone,
        });

        return { success: true };
    } catch (error: any) {
        logger.error("Error sending phone update OTP:", error);
        throw new HttpsError("internal", "Could not send SMS. " + error.message);
    }
});

export const verifyPhoneUpdateOtp = onCall({ region: "asia-south1", cors: true }, async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "User must be logged in.");
    }

    const { otp } = request.data;
    if (!otp) {
        throw new HttpsError("invalid-argument", "OTP is required.");
    }

    const userId = request.auth.uid;
    const otpDocRef = db.collection("phoneUpdateOtps").doc(userId);
    const otpDoc = await otpDocRef.get();

    if (!otpDoc.exists) {
        throw new HttpsError("not-found", "No OTP request found.");
    }

    const data = otpDoc.data();
    if (data?.otp !== otp) {
        throw new HttpsError("invalid-argument", "Incorrect OTP.");
    }

    if (Date.now() > data?.expiresAt) {
        throw new HttpsError("deadline-exceeded", "OTP has expired.");
    }

    const newPhone = data?.newPhone;

    try {
        // Update Firestore User Phone (Firebase Auth doesn't store phone in basic profile usually, it's a separate MFA field)
        await db.collection("users").doc(userId).update({
            phone: newPhone,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        // Delete OTP record
        await otpDocRef.delete();

        return { success: true, phone: newPhone };
    } catch (error: any) {
        logger.error("Error updating phone:", error);
        throw new HttpsError("internal", "Could not update phone number. " + error.message);
    }
});