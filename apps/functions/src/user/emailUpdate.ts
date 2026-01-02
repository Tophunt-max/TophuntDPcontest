import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { db, admin } from "../utils/firebase";
import * as nodemailer from "nodemailer";
import { MemoryOption } from "firebase-functions/v2/options";

// Configure your email transporter
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
});

const USER_CONFIG = {
    region: "us-central1",
    cpu: 1, // Increased to 1
    concurrency: 80,
    memory: "256MiB" as MemoryOption,
    maxInstances: 2,
    cors: true
};

export const sendEmailUpdateOtp = onCall(USER_CONFIG, async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "User must be logged in.");
    }

    const { newEmail } = request.data;
    if (!newEmail) {
        throw new HttpsError("invalid-argument", "New email is required.");
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

    try {
        // Save OTP to Firestore
        await db.collection("emailUpdateOtps").doc(request.auth.uid).set({
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
    } catch (error: any) {
        logger.error("Error sending email update OTP:", error);
        throw new HttpsError("internal", "Could not send OTP. " + error.message);
    }
});

export const verifyEmailUpdateOtp = onCall(USER_CONFIG, async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "User must be logged in.");
    }

    const { otp } = request.data;
    if (!otp) {
        throw new HttpsError("invalid-argument", "OTP is required.");
    }

    const userId = request.auth.uid;
    const otpDocRef = db.collection("emailUpdateOtps").doc(userId);
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

    const newEmail = data?.newEmail;

    try {
        // Update Auth Email
        await admin.auth().updateUser(userId, {
            email: newEmail,
        });

        // Update Firestore User Email
        await db.collection("users").doc(userId).update({
            email: newEmail,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        // Delete OTP record
        await otpDocRef.delete();

        return { success: true, email: newEmail };
    } catch (error: any) {
        logger.error("Error updating email:", error);
        throw new HttpsError("internal", "Could not update email. " + error.message);
    }
});
