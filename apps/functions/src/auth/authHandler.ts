import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";
import * as logger from "firebase-functions/logger";
import { db } from "../utils/firebase";
import { MemoryOption } from "firebase-functions/v2/options";
import * as nodemailer from "nodemailer";

// CPU must be >= 1 for concurrency
const AUTH_CONFIG = {
    region: "us-central1",
    cpu: 1, 
    concurrency: 80, // Can handle many requests
    minInstances: 0,
    maxInstances: 1, // REDUCED TO 1 to save quota
    memory: "256MiB" as MemoryOption,
    timeoutSeconds: 60,
    cors: true,
};

// Configure Email Transporter (For Email Update)
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
});

// Common disposable email domains to block
const DISPOSABLE_DOMAINS = new Set([
  "yopmail.com", "mailinator.com", "temp-mail.org", "10minutemail.com",
  "guerrillamail.com", "sharklasers.com", "maildrop.cc", "getnada.com",
  "dispostable.com", "tempmail.com", "throwawaymail.com", "mail.tm",
  "temp-mail.io", "yopmail.net", "cool.fr.nf", "jetable.org", "temporarily.de",
  "tempmailo.com", "smailpro.com", "trashmail.com", "luxusmail.org"
]);

// Reserved usernames that cannot be claimed
const RESERVED_USERNAMES = new Set([
  "admin", "administrator", "root", "system", "support", "help", "info",
  "contact", "webmaster", "security", "privacy", "policy", "terms",
  "login", "logout", "signin", "signup", "register", "auth", "user",
  "users", "profile", "settings", "config", "api", "dev", "test",
  "null", "undefined", "true", "false", "void", "anon", "anonymous",
  "official", "staff", "moderator"
]);

const USERNAME_REGEX = /^[a-zA-Z0-9_.]+$/;

// Helper to normalize phone numbers (remove spaces, dashes, parens)
function normalizePhoneNumber(phone: string | null | undefined): string | null {
    if (!phone) return null;
    return phone.replace(/[^\d+]/g, "").trim();
}

// Helper to check for disposable emails
function isDisposableEmail(email: string): boolean {
    if (!email) return false;
    const domain = email.split('@')[1];
    if (!domain) return false;
    return DISPOSABLE_DOMAINS.has(domain.toLowerCase());
}

// Helper to validate username
function validateUsername(username: string): string {
    const lower = username.toLowerCase();
    
    if (lower.length < 3) {
        throw new HttpsError("invalid-argument", "Username must be at least 3 characters long.");
    }

    if (lower.length > 30) {
        throw new HttpsError("invalid-argument", "Username must be less than 30 characters long.");
    }

    if (!USERNAME_REGEX.test(username)) {
        throw new HttpsError("invalid-argument", "Username can only contain letters, numbers, underscores, and dots.");
    }

    if (RESERVED_USERNAMES.has(lower)) {
        throw new HttpsError("invalid-argument", "This username is reserved and cannot be used.");
    }

    return lower;
}

/**
 * Helper to get Reward Settings from DB
 */
async function getRewardSettings() {
  const configDoc = await db.collection("settings").doc("appConfig").get();
  return configDoc.data()?.rewardSettings || { signupBonus: 100 };
}

/**
 * Master Auth Handler that processes all Auth and Account-related actions.
 */
export const authHandler = onCall(AUTH_CONFIG, async (request) => {
    if (!request.data || !request.data.action) {
      throw new HttpsError("invalid-argument", "Request must specify an 'action'.");
    }

    const { action } = request.data;
    const uid = request.auth?.uid;

    switch (action) {
        // ---------------------------------------------------------
        // ACTION: CHECK (email, phone, username)
        // ---------------------------------------------------------
        case "check": {
            const { type } = request.data;
            if (!type || !["email", "phone", "username"].includes(type)) {
                throw new HttpsError("invalid-argument", "Type must be 'email', 'phone', or 'username'.");
            }

            let value = request.data.value?.trim();
            if (!value) throw new HttpsError("invalid-argument", `Missing value for ${type}`);

            if (type === "phone") {
                value = normalizePhoneNumber(value);
                if (!value) throw new HttpsError("invalid-argument", "Invalid phone format");
            } else if (type === "username") {
                value = validateUsername(value);
            } else if (type === "email") {
                value = value.toLowerCase();
                if (isDisposableEmail(value)) throw new HttpsError("invalid-argument", "Disposable email blocked.");
            }

            let exists = false;
            if (type === "email") {
                try {
                    await admin.auth().getUserByEmail(value);
                    exists = true;
                } catch (error: any) {
                    if (error.code !== 'auth/user-not-found') throw error;
                }
            }

            if (!exists) {
                const snapshot = await db.collection("users").where(type, "==", value).limit(1).get();
                exists = !snapshot.empty;
            }
            return { exists };
        }

        // ---------------------------------------------------------
        // ACTION: CREATE USER (Auth + Profile)
        // ---------------------------------------------------------
        case "create": {
            const { email, password, username, fullName, avatarUrl, dob, phone, occupation, gender, following, platform, coordinates } = request.data;
            if (!email || !password || !username) throw new HttpsError("invalid-argument", "Email, password, and username are required.");
            if (isDisposableEmail(email)) throw new HttpsError("invalid-argument", "Disposable email blocked.");

            const validatedUsername = validateUsername(username);
            let userRecord;
            try {
                userRecord = await admin.auth().createUser({
                    email,
                    password,
                    displayName: validatedUsername,
                    photoURL: avatarUrl || null,
                });
            } catch (error: any) {
                if (error.code === "auth/email-already-exists") throw new HttpsError("already-exists", "Email already registered.");
                throw new HttpsError("internal", "Auth creation failed.");
            }

            const newUid = userRecord.uid;
            try {
                const rewardSettings = await getRewardSettings();
                await createFirestoreProfile(newUid, { email, username: validatedUsername, fullName, avatarUrl, dob, phone, occupation, gender, following, platform, coordinates }, rewardSettings.signupBonus || 0);
                return { status: "success", uid: newUid, message: "User created successfully" };
            } catch (error) {
                await admin.auth().deleteUser(newUid).catch(() => {});
                throw new HttpsError("internal", "Firestore profile creation failed.");
            }
        }

        // ---------------------------------------------------------
        // ACTION: CREATE PROFILE (Firestore Only)
        // ---------------------------------------------------------
        case "createProfile": {
            const profileUid = request.auth?.uid || request.data.uid;
            if (!profileUid) throw new HttpsError("unauthenticated", "User must be authenticated.");
            const { email } = request.data;
            if (email && isDisposableEmail(email)) throw new HttpsError("invalid-argument", "Disposable email blocked.");

            const rewardSettings = await getRewardSettings();
            await createFirestoreProfile(profileUid, request.data, rewardSettings.signupBonus || 0);
            return { status: "success", uid: profileUid, message: "Profile created successfully" };
        }

        // ---------------------------------------------------------
        // ACTION: GET USER BY IDENTIFIER
        // ---------------------------------------------------------
        case "getUserByIdentifier": {
            const { identifier, type } = request.data;
            if (!identifier || !type) throw new HttpsError("invalid-argument", "Identifier and type are required.");

            let queryField = type === 'email' ? 'email' : 'phone';
            let value = identifier;

            if (type === 'phone') {
                value = normalizePhoneNumber(identifier);
                if (!value) throw new HttpsError("invalid-argument", "Invalid phone format.");
            } else {
                value = identifier.toLowerCase();
            }

            const snapshot = await db.collection("users").where(queryField, "==", value).limit(1).get();
            if (snapshot.empty) return { found: false };

            const userData = snapshot.docs[0].data();
            return {
                found: true,
                user: {
                    uid: snapshot.docs[0].id,
                    name: userData.fullName || userData.username,
                    avatar: userData.profileImageUrl || null
                }
            };
        }

        // ---------------------------------------------------------
        // ACTION: SEND OTP TO PHONE (Forgot Password)
        // ---------------------------------------------------------
        case "sendOtpToPhone": {
            const { phone } = request.data;
            if (!phone) throw new HttpsError("invalid-argument", "Phone number is required.");

            const normalizedPhone = normalizePhoneNumber(phone);
            if (!normalizedPhone) throw new HttpsError("invalid-argument", "Invalid phone format.");

            const otp = Math.floor(100000 + Math.random() * 900000).toString();
            const expiresAt = admin.firestore.Timestamp.fromMillis(Date.now() + 10 * 60 * 1000);

            await db.collection("passwordResetOtps").doc(normalizedPhone).set({
                otp,
                expiresAt,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });

            const sid = process.env.TWILIO_ACCOUNT_SID;
            const token = process.env.TWILIO_AUTH_TOKEN;
            const from = process.env.TWILIO_PHONE_NUMBER;

            if (sid && token && from) {
                const client = require("twilio")(sid, token);
                await client.messages.create({
                    body: `Your Password Reset OTP is: ${otp}. Valid for 10 minutes.`,
                    from: from,
                    to: normalizedPhone,
                });
            } else {
                logger.warn("Twilio credentials missing. OTP generated but not sent: ", otp);
            }

            return { success: true };
        }

        // ---------------------------------------------------------
        // ACTION: VERIFY OTP (Forgot Password)
        // ---------------------------------------------------------
        case "verifyOtp": {
            const { phone, code } = request.data;
            if (!phone || !code) throw new HttpsError("invalid-argument", "Phone and code are required.");

            const normalizedPhone = normalizePhoneNumber(phone);
            if (!normalizedPhone) throw new HttpsError("invalid-argument", "Invalid phone format.");

            const otpDoc = await db.collection("passwordResetOtps").doc(normalizedPhone).get();
            if (!otpDoc.exists) throw new HttpsError("not-found", "No OTP found.");

            const data = otpDoc.data();
            if (data?.otp !== code) throw new HttpsError("invalid-argument", "Invalid OTP.");
            if (data?.expiresAt.toMillis() < Date.now()) throw new HttpsError("deadline-exceeded", "OTP expired.");

            return { success: true };
        }

        // ---------------------------------------------------------
        // ACTION: UPDATE PASSWORD WITH PHONE (Forgot Password)
        // ---------------------------------------------------------
        case "updatePasswordWithPhone": {
            const { phone, newPassword } = request.data;
            if (!phone || !newPassword) throw new HttpsError("invalid-argument", "Phone and password required.");

            const normalizedPhone = normalizePhoneNumber(phone);
            if (!normalizedPhone) throw new HttpsError("invalid-argument", "Invalid phone format.");

            const otpDoc = await db.collection("passwordResetOtps").doc(normalizedPhone).get();
            if (!otpDoc.exists) throw new HttpsError("permission-denied", "OTP verification required.");

            const userSnapshot = await db.collection("users").where("phone", "==", normalizedPhone).limit(1).get();
            if (userSnapshot.empty) throw new HttpsError("not-found", "User not found.");

            const passUid = userSnapshot.docs[0].id;
            await admin.auth().updateUser(passUid, { password: newPassword });
            await db.collection("passwordResetOtps").doc(normalizedPhone).delete();

            return { success: true };
        }

        // ---------------------------------------------------------
        // ACTION: SEND EMAIL UPDATE OTP
        // ---------------------------------------------------------
        case "sendEmailOtp": {
            if (!uid) throw new HttpsError("unauthenticated", "User must be logged in.");
            const { newEmail } = request.data;
            if (!newEmail) throw new HttpsError("invalid-argument", "New email is required.");

            const otp = Math.floor(100000 + Math.random() * 900000).toString();
            const expiresAt = Date.now() + 10 * 60 * 1000;

            await db.collection("emailUpdateOtps").doc(uid).set({ newEmail, otp, expiresAt });

            const mailOptions = {
                from: `"TopHunt" <${process.env.EMAIL_USER}>`,
                to: newEmail,
                subject: "Verify your new email address",
                text: `Your OTP for email update is: ${otp}. It will expire in 10 minutes.`,
                html: `<h3>Email Verification</h3><p>Your OTP for updating your email address is: <b>${otp}</b></p>`,
            };

            await transporter.sendMail(mailOptions);
            return { success: true };
        }

        // ---------------------------------------------------------
        // ACTION: VERIFY EMAIL UPDATE OTP
        // ---------------------------------------------------------
        case "verifyEmailOtp": {
            if (!uid) throw new HttpsError("unauthenticated", "User must be logged in.");
            const { otp } = request.data;
            if (!otp) throw new HttpsError("invalid-argument", "OTP is required.");

            const otpDocRef = db.collection("emailUpdateOtps").doc(uid);
            const otpDoc = await otpDocRef.get();
            if (!otpDoc.exists) throw new HttpsError("not-found", "No OTP request found.");

            const data = otpDoc.data();
            if (data?.otp !== otp) throw new HttpsError("invalid-argument", "Incorrect OTP.");
            if (Date.now() > data?.expiresAt) throw new HttpsError("deadline-exceeded", "OTP expired.");

            const newEmail = data?.newEmail;
            await admin.auth().updateUser(uid, { email: newEmail });
            await db.collection("users").doc(uid).update({ email: newEmail, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
            await otpDocRef.delete();

            return { success: true, email: newEmail };
        }

        // ---------------------------------------------------------
        // ACTION: SEND PHONE UPDATE OTP
        // ---------------------------------------------------------
        case "sendPhoneOtp": {
            if (!uid) throw new HttpsError("unauthenticated", "User must be logged in.");
            const { newPhone } = request.data;
            if (!newPhone) throw new HttpsError("invalid-argument", "New phone number is required.");

            const otp = Math.floor(100000 + Math.random() * 900000).toString();
            const expiresAt = Date.now() + 10 * 60 * 1000;

            await db.collection("phoneUpdateOtps").doc(uid).set({ newPhone, otp, expiresAt });

            const sid = process.env.TWILIO_ACCOUNT_SID;
            const token = process.env.TWILIO_AUTH_TOKEN;
            const from = process.env.TWILIO_PHONE_NUMBER;

            if (sid && token && from) {
                const client = require("twilio")(sid, token);
                await client.messages.create({
                    body: `Your TopHunt OTP for phone number update is: ${otp}.`,
                    from: from,
                    to: newPhone,
                });
            } else {
                logger.warn("Twilio credentials missing. OTP: ", otp);
            }
            return { success: true };
        }

        // ---------------------------------------------------------
        // ACTION: VERIFY PHONE UPDATE OTP
        // ---------------------------------------------------------
        case "verifyPhoneOtp": {
            if (!uid) throw new HttpsError("unauthenticated", "User must be logged in.");
            const { otp } = request.data;
            if (!otp) throw new HttpsError("invalid-argument", "OTP is required.");

            const otpDocRef = db.collection("phoneUpdateOtps").doc(uid);
            const otpDoc = await otpDocRef.get();
            if (!otpDoc.exists) throw new HttpsError("not-found", "No OTP request found.");

            const data = otpDoc.data();
            if (data?.otp !== otp) throw new HttpsError("invalid-argument", "Incorrect OTP.");
            if (Date.now() > data?.expiresAt) throw new HttpsError("deadline-exceeded", "OTP expired.");

            const newPhone = data?.newPhone;
            await db.collection("users").doc(uid).update({ phone: newPhone, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
            await otpDocRef.delete();

            return { success: true, phone: newPhone };
        }

        default:
            throw new HttpsError("invalid-argument", `Unknown action: ${action}`);
    }
});

async function createFirestoreProfile(uid: string, data: any, signupBonus: number = 0) {
  const userRef = db.collection("users").doc(uid);
  const normalizedPhone = normalizePhoneNumber(data.phone);

  const profileData = {
    uid,
    email: data.email || null,
    username: data.username ? data.username.toLowerCase() : null,
    fullName: data.fullName || null,
    profileImageUrl: data.avatarUrl || null,
    dob: data.dob || null,
    phone: normalizedPhone,
    occupation: data.occupation || null,
    gender: data.gender || null,
    following: data.following || [],
    platform: data.platform || "unknown",
    coordinates: data.coordinates || null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    signupCompleted: true,
    Dpcoin: signupBonus,
    xp: 0,
    level: 1, 
    stats: {
       followersCount: 0, 
       followingCount: 0, 
       wins: 0,
       totalVotesReceived: 0,
       contestsJoined: 0,
    }
  };

  await userRef.set(profileData, { merge: true });

  if (signupBonus > 0) {
    await db.collection("coinTransactions").add({
        uid,
        amount: signupBonus,
        type: "signup_bonus",
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        description: "Welcome bonus for joining TopHunt!"
    });
  }
}
