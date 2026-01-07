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
exports.authHandler = void 0;
const https_1 = require("firebase-functions/v2/https");
const admin = __importStar(require("firebase-admin"));
const logger = __importStar(require("firebase-functions/logger"));
const firebase_1 = require("../utils/firebase");
const nodemailer = __importStar(require("nodemailer"));
// CPU must be >= 1 for concurrency
const AUTH_CONFIG = {
    region: "us-central1",
    cpu: 1,
    concurrency: 80, // Can handle many requests
    minInstances: 0,
    maxInstances: 1, // REDUCED TO 1 to save quota
    memory: "256MiB",
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
function normalizePhoneNumber(phone) {
    if (!phone)
        return null;
    return phone.replace(/[^\d+]/g, "").trim();
}
// Helper to check for disposable emails
function isDisposableEmail(email) {
    if (!email)
        return false;
    const domain = email.split('@')[1];
    if (!domain)
        return false;
    return DISPOSABLE_DOMAINS.has(domain.toLowerCase());
}
// Helper to validate username
function validateUsername(username) {
    const lower = username.toLowerCase();
    if (lower.length < 3) {
        throw new https_1.HttpsError("invalid-argument", "Username must be at least 3 characters long.");
    }
    if (lower.length > 30) {
        throw new https_1.HttpsError("invalid-argument", "Username must be less than 30 characters long.");
    }
    if (!USERNAME_REGEX.test(username)) {
        throw new https_1.HttpsError("invalid-argument", "Username can only contain letters, numbers, underscores, and dots.");
    }
    if (RESERVED_USERNAMES.has(lower)) {
        throw new https_1.HttpsError("invalid-argument", "This username is reserved and cannot be used.");
    }
    return lower;
}
/**
 * Helper to get Reward Settings from DB
 */
async function getRewardSettings() {
    var _a;
    const configDoc = await firebase_1.db.collection("settings").doc("appConfig").get();
    return ((_a = configDoc.data()) === null || _a === void 0 ? void 0 : _a.rewardSettings) || { signupBonus: 100 };
}
/**
 * Master Auth Handler that processes all Auth and Account-related actions.
 */
exports.authHandler = (0, https_1.onCall)(AUTH_CONFIG, async (request) => {
    var _a, _b, _c;
    if (!request.data || !request.data.action) {
        throw new https_1.HttpsError("invalid-argument", "Request must specify an 'action'.");
    }
    const { action } = request.data;
    const uid = (_a = request.auth) === null || _a === void 0 ? void 0 : _a.uid;
    switch (action) {
        // ---------------------------------------------------------
        // ACTION: CHECK (email, phone, username)
        // ---------------------------------------------------------
        case "check": {
            const { type } = request.data;
            if (!type || !["email", "phone", "username"].includes(type)) {
                throw new https_1.HttpsError("invalid-argument", "Type must be 'email', 'phone', or 'username'.");
            }
            let value = (_b = request.data.value) === null || _b === void 0 ? void 0 : _b.trim();
            if (!value)
                throw new https_1.HttpsError("invalid-argument", `Missing value for ${type}`);
            if (type === "phone") {
                value = normalizePhoneNumber(value);
                if (!value)
                    throw new https_1.HttpsError("invalid-argument", "Invalid phone format");
            }
            else if (type === "username") {
                value = validateUsername(value);
            }
            else if (type === "email") {
                value = value.toLowerCase();
                if (isDisposableEmail(value))
                    throw new https_1.HttpsError("invalid-argument", "Disposable email blocked.");
            }
            let exists = false;
            if (type === "email") {
                try {
                    await admin.auth().getUserByEmail(value);
                    exists = true;
                }
                catch (error) {
                    if (error.code !== 'auth/user-not-found')
                        throw error;
                }
            }
            if (!exists) {
                const snapshot = await firebase_1.db.collection("users").where(type, "==", value).limit(1).get();
                exists = !snapshot.empty;
            }
            return { exists };
        }
        // ---------------------------------------------------------
        // ACTION: CREATE USER (Auth + Profile)
        // ---------------------------------------------------------
        case "create": {
            const { email, password, username, fullName, avatarUrl, dob, phone, occupation, gender, following, platform, coordinates } = request.data;
            if (!email || !password || !username)
                throw new https_1.HttpsError("invalid-argument", "Email, password, and username are required.");
            if (isDisposableEmail(email))
                throw new https_1.HttpsError("invalid-argument", "Disposable email blocked.");
            const validatedUsername = validateUsername(username);
            let userRecord;
            try {
                userRecord = await admin.auth().createUser({
                    email,
                    password,
                    displayName: validatedUsername,
                    photoURL: avatarUrl || null,
                });
            }
            catch (error) {
                if (error.code === "auth/email-already-exists")
                    throw new https_1.HttpsError("already-exists", "Email already registered.");
                throw new https_1.HttpsError("internal", "Auth creation failed.");
            }
            const newUid = userRecord.uid;
            try {
                const rewardSettings = await getRewardSettings();
                await createFirestoreProfile(newUid, { email, username: validatedUsername, fullName, avatarUrl, dob, phone, occupation, gender, following, platform, coordinates }, rewardSettings.signupBonus || 0);
                return { status: "success", uid: newUid, message: "User created successfully" };
            }
            catch (error) {
                await admin.auth().deleteUser(newUid).catch(() => { });
                throw new https_1.HttpsError("internal", "Firestore profile creation failed.");
            }
        }
        // ---------------------------------------------------------
        // ACTION: CREATE PROFILE (Firestore Only)
        // ---------------------------------------------------------
        case "createProfile": {
            const profileUid = ((_c = request.auth) === null || _c === void 0 ? void 0 : _c.uid) || request.data.uid;
            if (!profileUid)
                throw new https_1.HttpsError("unauthenticated", "User must be authenticated.");
            const { email } = request.data;
            if (email && isDisposableEmail(email))
                throw new https_1.HttpsError("invalid-argument", "Disposable email blocked.");
            const rewardSettings = await getRewardSettings();
            await createFirestoreProfile(profileUid, request.data, rewardSettings.signupBonus || 0);
            return { status: "success", uid: profileUid, message: "Profile created successfully" };
        }
        // ---------------------------------------------------------
        // ACTION: GET USER BY IDENTIFIER
        // ---------------------------------------------------------
        case "getUserByIdentifier": {
            const { identifier, type } = request.data;
            if (!identifier || !type)
                throw new https_1.HttpsError("invalid-argument", "Identifier and type are required.");
            let queryField = type === 'email' ? 'email' : 'phone';
            let value = identifier;
            if (type === 'phone') {
                value = normalizePhoneNumber(identifier);
                if (!value)
                    throw new https_1.HttpsError("invalid-argument", "Invalid phone format.");
            }
            else {
                value = identifier.toLowerCase();
            }
            const snapshot = await firebase_1.db.collection("users").where(queryField, "==", value).limit(1).get();
            if (snapshot.empty)
                return { found: false };
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
            if (!phone)
                throw new https_1.HttpsError("invalid-argument", "Phone number is required.");
            const normalizedPhone = normalizePhoneNumber(phone);
            if (!normalizedPhone)
                throw new https_1.HttpsError("invalid-argument", "Invalid phone format.");
            const otp = Math.floor(100000 + Math.random() * 900000).toString();
            const expiresAt = admin.firestore.Timestamp.fromMillis(Date.now() + 10 * 60 * 1000);
            await firebase_1.db.collection("passwordResetOtps").doc(normalizedPhone).set({
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
            }
            else {
                logger.warn("Twilio credentials missing. OTP generated but not sent: ", otp);
            }
            return { success: true };
        }
        // ---------------------------------------------------------
        // ACTION: VERIFY OTP (Forgot Password)
        // ---------------------------------------------------------
        case "verifyOtp": {
            const { phone, code } = request.data;
            if (!phone || !code)
                throw new https_1.HttpsError("invalid-argument", "Phone and code are required.");
            const normalizedPhone = normalizePhoneNumber(phone);
            if (!normalizedPhone)
                throw new https_1.HttpsError("invalid-argument", "Invalid phone format.");
            const otpDoc = await firebase_1.db.collection("passwordResetOtps").doc(normalizedPhone).get();
            if (!otpDoc.exists)
                throw new https_1.HttpsError("not-found", "No OTP found.");
            const data = otpDoc.data();
            if ((data === null || data === void 0 ? void 0 : data.otp) !== code)
                throw new https_1.HttpsError("invalid-argument", "Invalid OTP.");
            if ((data === null || data === void 0 ? void 0 : data.expiresAt.toMillis()) < Date.now())
                throw new https_1.HttpsError("deadline-exceeded", "OTP expired.");
            return { success: true };
        }
        // ---------------------------------------------------------
        // ACTION: UPDATE PASSWORD WITH PHONE (Forgot Password)
        // ---------------------------------------------------------
        case "updatePasswordWithPhone": {
            const { phone, newPassword } = request.data;
            if (!phone || !newPassword)
                throw new https_1.HttpsError("invalid-argument", "Phone and password required.");
            const normalizedPhone = normalizePhoneNumber(phone);
            if (!normalizedPhone)
                throw new https_1.HttpsError("invalid-argument", "Invalid phone format.");
            const otpDoc = await firebase_1.db.collection("passwordResetOtps").doc(normalizedPhone).get();
            if (!otpDoc.exists)
                throw new https_1.HttpsError("permission-denied", "OTP verification required.");
            const userSnapshot = await firebase_1.db.collection("users").where("phone", "==", normalizedPhone).limit(1).get();
            if (userSnapshot.empty)
                throw new https_1.HttpsError("not-found", "User not found.");
            const passUid = userSnapshot.docs[0].id;
            await admin.auth().updateUser(passUid, { password: newPassword });
            await firebase_1.db.collection("passwordResetOtps").doc(normalizedPhone).delete();
            return { success: true };
        }
        // ---------------------------------------------------------
        // ACTION: SEND EMAIL UPDATE OTP
        // ---------------------------------------------------------
        case "sendEmailOtp": {
            if (!uid)
                throw new https_1.HttpsError("unauthenticated", "User must be logged in.");
            const { newEmail } = request.data;
            if (!newEmail)
                throw new https_1.HttpsError("invalid-argument", "New email is required.");
            const otp = Math.floor(100000 + Math.random() * 900000).toString();
            const expiresAt = Date.now() + 10 * 60 * 1000;
            await firebase_1.db.collection("emailUpdateOtps").doc(uid).set({ newEmail, otp, expiresAt });
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
            if (!uid)
                throw new https_1.HttpsError("unauthenticated", "User must be logged in.");
            const { otp } = request.data;
            if (!otp)
                throw new https_1.HttpsError("invalid-argument", "OTP is required.");
            const otpDocRef = firebase_1.db.collection("emailUpdateOtps").doc(uid);
            const otpDoc = await otpDocRef.get();
            if (!otpDoc.exists)
                throw new https_1.HttpsError("not-found", "No OTP request found.");
            const data = otpDoc.data();
            if ((data === null || data === void 0 ? void 0 : data.otp) !== otp)
                throw new https_1.HttpsError("invalid-argument", "Incorrect OTP.");
            if (Date.now() > (data === null || data === void 0 ? void 0 : data.expiresAt))
                throw new https_1.HttpsError("deadline-exceeded", "OTP expired.");
            const newEmail = data === null || data === void 0 ? void 0 : data.newEmail;
            await admin.auth().updateUser(uid, { email: newEmail });
            await firebase_1.db.collection("users").doc(uid).update({ email: newEmail, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
            await otpDocRef.delete();
            return { success: true, email: newEmail };
        }
        // ---------------------------------------------------------
        // ACTION: SEND PHONE UPDATE OTP
        // ---------------------------------------------------------
        case "sendPhoneOtp": {
            if (!uid)
                throw new https_1.HttpsError("unauthenticated", "User must be logged in.");
            const { newPhone } = request.data;
            if (!newPhone)
                throw new https_1.HttpsError("invalid-argument", "New phone number is required.");
            const otp = Math.floor(100000 + Math.random() * 900000).toString();
            const expiresAt = Date.now() + 10 * 60 * 1000;
            await firebase_1.db.collection("phoneUpdateOtps").doc(uid).set({ newPhone, otp, expiresAt });
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
            }
            else {
                logger.warn("Twilio credentials missing. OTP: ", otp);
            }
            return { success: true };
        }
        // ---------------------------------------------------------
        // ACTION: VERIFY PHONE UPDATE OTP
        // ---------------------------------------------------------
        case "verifyPhoneOtp": {
            if (!uid)
                throw new https_1.HttpsError("unauthenticated", "User must be logged in.");
            const { otp } = request.data;
            if (!otp)
                throw new https_1.HttpsError("invalid-argument", "OTP is required.");
            const otpDocRef = firebase_1.db.collection("phoneUpdateOtps").doc(uid);
            const otpDoc = await otpDocRef.get();
            if (!otpDoc.exists)
                throw new https_1.HttpsError("not-found", "No OTP request found.");
            const data = otpDoc.data();
            if ((data === null || data === void 0 ? void 0 : data.otp) !== otp)
                throw new https_1.HttpsError("invalid-argument", "Incorrect OTP.");
            if (Date.now() > (data === null || data === void 0 ? void 0 : data.expiresAt))
                throw new https_1.HttpsError("deadline-exceeded", "OTP expired.");
            const newPhone = data === null || data === void 0 ? void 0 : data.newPhone;
            await firebase_1.db.collection("users").doc(uid).update({ phone: newPhone, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
            await otpDocRef.delete();
            return { success: true, phone: newPhone };
        }
        default:
            throw new https_1.HttpsError("invalid-argument", `Unknown action: ${action}`);
    }
});
async function createFirestoreProfile(uid, data, signupBonus = 0) {
    const userRef = firebase_1.db.collection("users").doc(uid);
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
        await firebase_1.db.collection("coinTransactions").add({
            uid,
            amount: signupBonus,
            type: "signup_bonus",
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            description: "Welcome bonus for joining TopHunt!"
        });
    }
}
//# sourceMappingURL=authHandler.js.map