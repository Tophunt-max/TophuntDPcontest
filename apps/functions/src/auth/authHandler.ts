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
    concurrency: 80, 
    minInstances: 0,
    maxInstances: 1, 
    memory: "512MiB" as MemoryOption,
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

/**
 * PRODUCTION-GRADE PHONE NORMALIZATION (E.164 Format)
 */
function normalizePhoneNumber(phone: string | null | undefined): string | null {
    if (!phone) return null;
    let cleaned = phone.replace(/[^\d+]/g, "").trim();
    if (cleaned.startsWith("00")) cleaned = "+" + cleaned.substring(2);
    if (!cleaned.startsWith("+") && cleaned.length > 5) cleaned = "+" + cleaned;
    return cleaned;
}

function isDisposableEmail(email: string): boolean {
    if (!email) return false;
    const domain = email.split('@')[1];
    if (!domain) return false;
    return DISPOSABLE_DOMAINS.has(domain.toLowerCase());
}

function validateUsername(username: string): string {
    const lower = username.toLowerCase().trim();
    if (lower.length < 3) throw new HttpsError("invalid-argument", "Username too short.");
    if (lower.length > 30) throw new HttpsError("invalid-argument", "Username too long.");
    if (!USERNAME_REGEX.test(lower)) throw new HttpsError("invalid-argument", "Username can only contain letters, numbers, underscores, and dots.");
    if (RESERVED_USERNAMES.has(lower)) throw new HttpsError("invalid-argument", "This username is reserved.");
    return lower;
}

async function getRewardSettings() {
  const configDoc = await db.collection("settings").doc("appConfig").get();
  return configDoc.data()?.rewardSettings || { signupBonus: 100 };
}

function getClientIp(request: any): string {
    const headers = request.rawRequest?.headers;
    const xForwardedFor = headers?.['x-forwarded-for'] as string;
    if (xForwardedFor) return xForwardedFor.split(',')[0].trim();
    return request.rawRequest?.socket?.remoteAddress || 'unknown';
}

/**
 * Master Auth Handler
 */
export const authHandler = onCall(AUTH_CONFIG, async (request) => {
    if (!request.data || !request.data.action) {
      throw new HttpsError("invalid-argument", "Request must specify an 'action'.");
    }

    const { action } = request.data;
    const uid = request.auth?.uid;
    const clientIp = getClientIp(request);

    logger.info(`Auth action: ${action} for UID: ${uid}`);

    switch (action) {
        case "check": {
            const { type } = request.data;
            if (!type || !["email", "phone", "username"].includes(type)) throw new HttpsError("invalid-argument", "Invalid type.");
            let value = request.data.value?.trim();
            if (!value) throw new HttpsError("invalid-argument", `Missing value for ${type}`);

            if (type === "phone") value = normalizePhoneNumber(value);
            else if (type === "username") value = validateUsername(value);
            else if (type === "email") {
                value = value.toLowerCase();
                if (isDisposableEmail(value)) throw new HttpsError("invalid-argument", "Disposable email blocked.");
            }

            let exists = false;
            let existingUid = null;

            if (type === "email") {
                try {
                    const userRecord = await admin.auth().getUserByEmail(value);
                    exists = true; existingUid = userRecord.uid;
                } catch (error: any) { if (error.code !== 'auth/user-not-found') throw error; }
            } else if (type === "phone") {
                try {
                    const userRecord = await admin.auth().getUserByPhoneNumber(value!);
                    exists = true; existingUid = userRecord.uid;
                } catch (error: any) { if (error.code !== 'auth/user-not-found') throw error; }
            } else if (type === "username") {
                const usernameDoc = await db.collection("usernames").doc(value).get();
                if (usernameDoc.exists) { exists = true; existingUid = usernameDoc.data()?.uid; }
            }

            if (!exists) {
                const snapshot = await db.collection("users").where(type, "==", value).limit(1).get();
                exists = !snapshot.empty;
                if (exists) existingUid = snapshot.docs[0].id;
            }
            return { exists, uid: existingUid };
        }

        case "create": {
            const { email, password, username, fullName, avatarUrl, dob, phone, occupation, gender, following, platform, coordinates, deviceInfo } = request.data;
            if (!email || !password || !username) throw new HttpsError("invalid-argument", "Missing fields.");
            if (isDisposableEmail(email)) throw new HttpsError("invalid-argument", "Disposable email blocked.");

            const validatedUsername = validateUsername(username);
            let userRecord;

            try {
                userRecord = await admin.auth().createUser({
                    email: email.toLowerCase(),
                    password,
                    displayName: validatedUsername,
                    photoURL: avatarUrl || null,
                });
            } catch (error: any) {
                if (error.code === "auth/email-already-exists") throw new HttpsError("already-exists", "Email registered.");
                throw new HttpsError("internal", error.message || "Auth failed.");
            }

            const newUid = userRecord.uid;
            try {
                const rewardSettings = await getRewardSettings();
                await createFirestoreProfile(newUid, { 
                    email, username: validatedUsername, fullName, avatarUrl, dob, phone, occupation, gender, following, platform, coordinates, deviceInfo,
                    signupIp: clientIp, lastIp: clientIp
                }, rewardSettings.signupBonus || 0);
                return { status: "success", uid: newUid };
            } catch (error: any) {
                await admin.auth().deleteUser(newUid).catch(() => {});
                throw new HttpsError("internal", error.message || "Profile failed.");
            }
        }

        case "createProfile": {
            const profileUid = request.auth?.uid || request.data.uid;
            if (!profileUid) throw new HttpsError("unauthenticated", "Auth required.");
            const rewardSettings = await getRewardSettings();
            await createFirestoreProfile(profileUid, { ...request.data, lastIp: clientIp }, rewardSettings.signupBonus || 0);
            return { status: "success", uid: profileUid };
        }

        case "getUserByIdentifier": {
            const { identifier, type } = request.data;
            let val = identifier.trim();
            if (type === 'phone') val = normalizePhoneNumber(identifier);
            else if (type === 'email' || type === 'username') val = val.toLowerCase();

            const snapshot = await db.collection("users").where(type, "==", val).limit(1).get();
            if (snapshot.empty) return { found: false };
            const userData = snapshot.docs[0].data();
            return { found: true, user: { uid: snapshot.docs[0].id, name: userData.fullName || userData.username, avatar: userData.profileImageUrl || null } };
        }

        case "sendOtpToPhone": {
            const { phone } = request.data;
            const normalizedPhone = normalizePhoneNumber(phone);
            const otp = Math.floor(100000 + Math.random() * 900000).toString();
            await db.collection("passwordResetOtps").doc(normalizedPhone!).set({ otp, expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + 600000), createdAt: admin.firestore.FieldValue.serverTimestamp() });
            const sid = process.env.TWILIO_ACCOUNT_SID;
            const token = process.env.TWILIO_AUTH_TOKEN;
            if (sid && token) {
                const client = require("twilio")(sid, token);
                await client.messages.create({ body: `Your OTP is: ${otp}`, from: process.env.TWILIO_PHONE_NUMBER, to: normalizedPhone });
            }
            return { success: true };
        }

        case "verifyOtp": {
            const { phone, code } = request.data;
            const normalizedPhone = normalizePhoneNumber(phone);
            const otpDoc = await db.collection("passwordResetOtps").doc(normalizedPhone!).get();
            if (otpDoc.exists && otpDoc.data()?.otp === code) return { success: true };
            throw new HttpsError("invalid-argument", "Invalid OTP.");
        }

        case "updatePasswordWithPhone": {
            const { phone, newPassword } = request.data;
            const normalizedPhone = normalizePhoneNumber(phone);
            const userSnapshot = await db.collection("users").where("phone", "==", normalizedPhone).limit(1).get();
            if (userSnapshot.empty) throw new HttpsError("not-found", "User not found.");
            await admin.auth().updateUser(userSnapshot.docs[0].id, { password: newPassword });
            return { success: true };
        }

        case "sendEmailOtp": {
            if (!uid) throw new HttpsError("unauthenticated", "Auth required.");
            const { newEmail } = request.data;
            const otp = Math.floor(100000 + Math.random() * 900000).toString();
            await db.collection("emailUpdateOtps").doc(uid).set({ newEmail, otp, expiresAt: Date.now() + 600000 });
            await transporter.sendMail({ from: `"TopHunt" <${process.env.EMAIL_USER}>`, to: newEmail, subject: "Verify Email", text: `OTP: ${otp}` });
            return { success: true };
        }

        case "verifyEmailOtp": {
            if (!uid) throw new HttpsError("unauthenticated", "Auth required.");
            const { otp } = request.data;
            const otpDoc = await db.collection("emailUpdateOtps").doc(uid).get();
            if (otpDoc.exists && otpDoc.data()?.otp === otp) {
                const newEmail = otpDoc.data()?.newEmail;
                await admin.auth().updateUser(uid, { email: newEmail });
                await db.collection("users").doc(uid).update({ email: newEmail, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
                return { success: true, email: newEmail };
            }
            throw new HttpsError("invalid-argument", "Invalid OTP.");
        }

        case "sendPhoneOtp": {
            if (!uid) throw new HttpsError("unauthenticated", "Auth required.");
            const { newPhone } = request.data;
            const otp = Math.floor(100000 + Math.random() * 900000).toString();
            await db.collection("phoneUpdateOtps").doc(uid).set({ newPhone, otp, expiresAt: Date.now() + 600000 });
            // Twilio logic here...
            return { success: true };
        }

        case "verifyPhoneOtp": {
            if (!uid) throw new HttpsError("unauthenticated", "Auth required.");
            const { otp } = request.data;
            const otpDoc = await db.collection("phoneUpdateOtps").doc(uid).get();
            if (otpDoc.exists && otpDoc.data()?.otp === otp) {
                const newPhone = otpDoc.data()?.newPhone;
                await db.collection("users").doc(uid).update({ phone: newPhone, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
                return { success: true, phone: newPhone };
            }
            throw new HttpsError("invalid-argument", "Invalid OTP.");
        }

        default: throw new HttpsError("invalid-argument", `Unknown action: ${action}`);
    }
});

async function createFirestoreProfile(uid: string, data: any, bonus: number = 0) {
  const userRef = db.collection("users").doc(uid);
  const username = data.username ? data.username.toLowerCase().trim() : null;
  const following = Array.isArray(data.following) ? data.following : [];

  return db.runTransaction(async (transaction) => {
    if (username) {
      const uRef = db.collection("usernames").doc(username);
      const uDoc = await transaction.get(uRef);
      if (uDoc.exists && uDoc.data()?.uid !== uid) throw new Error("Username taken.");
      transaction.set(uRef, { uid, createdAt: admin.firestore.FieldValue.serverTimestamp() });
    }

    const existingDoc = await transaction.get(userRef);
    const existing = existingDoc.exists ? existingDoc.data() : null;

    // UPDATE TARGET USERS (NEW LOGIC ADDED SAFELY)
    if (!existing && following.length > 0) {
        following.forEach((targetId: string) => {
            const tRef = db.collection("users").doc(targetId);
            transaction.update(tRef, { 
                "stats.followersCount": admin.firestore.FieldValue.increment(1),
                "followers": admin.firestore.FieldValue.arrayUnion(uid)
            });
        });
    }

    const profile = {
      uid,
      email: data.email?.toLowerCase() || existing?.email || null,
      username: username || existing?.username || null,
      fullName: data.fullName || existing?.fullName || null,
      profileImageUrl: data.avatarUrl || existing?.profileImageUrl || null,
      dob: data.dob || existing?.dob || null,
      phone: normalizePhoneNumber(data.phone) || existing?.phone || null,
      occupation: data.occupation || existing?.occupation || null,
      gender: data.gender || existing?.gender || null,
      following: following.length > 0 ? following : (existing?.following || []),
      platform: data.platform || existing?.platform || "unknown",
      coordinates: data.coordinates || existing?.coordinates || null,
      deviceInfo: data.deviceInfo || existing?.deviceInfo || null,
      createdAt: existing?.createdAt || admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      signupCompleted: true,
      Dpcoin: existing?.Dpcoin ?? bonus,
      xp: existing?.xp ?? 0,
      level: existing?.level ?? 1, 
      stats: existing?.stats || { followersCount: 0, followingCount: following.length, wins: 0, totalVotesReceived: 0, contestsJoined: 0 }
    };

    transaction.set(userRef, profile, { merge: true });
    if (bonus > 0 && !existing) {
      transaction.set(db.collection("coinTransactions").doc(), { uid, amount: bonus, type: "signup_bonus", timestamp: admin.firestore.FieldValue.serverTimestamp() });
    }
  });
}
