/**
 * /auth — port of apps/functions/src/auth/authHandler.ts (the callable
 * `authHandler`). Same action-based contract: POST { action, ...data }.
 * Firebase Auth stays the source of truth (via Identity Toolkit REST).
 */
import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import type { Env, Variables } from "../types";
import { getDb, schema } from "../db";
import { httpsError } from "../lib/http";
import { optionalAuth } from "../middleware/auth";
import {
  createAuthUser,
  getUserByEmail,
  updateAuthUser,
} from "../lib/firebaseAdmin";
import { getRewardSettings } from "../lib/settings";
import { setOtp, generateOtp, verifyOtp } from "../lib/otp";
import { validatePasswordStrength } from "../lib/password";
import { rateLimit, enforceSendCooldown, markSent, clientIp } from "../lib/rateLimit";
import { assertIdentifiersAvailable } from "../lib/userIdentifiers";

/** Per-recipient cooldown between OTP sends (seconds). */
const OTP_SEND_COOLDOWN = 60;

/** How long a successful password-reset OTP verification stays valid before the
 * password must actually be changed. */
const PWRESET_VERIFIED_TTL = 10 * 60;
const pwVerifiedKey = (phone: string) => `pwverified:${phone}`;
import { sendSms } from "../lib/twilio";
import { sendEmail } from "../lib/email";
import { newId, now } from "../lib/ids";

const DISPOSABLE_DOMAINS = new Set([
  "yopmail.com", "mailinator.com", "temp-mail.org", "10minutemail.com",
  "guerrillamail.com", "sharklasers.com", "maildrop.cc", "getnada.com",
  "dispostable.com", "tempmail.com", "throwawaymail.com", "mail.tm",
  "temp-mail.io", "yopmail.net", "cool.fr.nf", "jetable.org", "temporarily.de",
  "tempmailo.com", "smailpro.com", "trashmail.com", "luxusmail.org",
]);
const RESERVED_USERNAMES = new Set([
  "admin", "administrator", "root", "system", "support", "help", "info",
  "contact", "webmaster", "security", "privacy", "policy", "terms", "login",
  "logout", "signin", "signup", "register", "auth", "user", "users", "profile",
  "settings", "config", "api", "dev", "test", "null", "undefined", "true",
  "false", "void", "anon", "anonymous", "official", "staff", "moderator",
]);
const USERNAME_REGEX = /^[a-zA-Z0-9_.]+$/;

function normalizePhone(phone?: string | null): string | null {
  if (!phone) return null;
  return phone.replace(/[^\d+]/g, "").trim() || null;
}
function isDisposableEmail(email: string): boolean {
  const domain = email.split("@")[1];
  return domain ? DISPOSABLE_DOMAINS.has(domain.toLowerCase()) : false;
}
function validateUsername(username: string): string {
  const lower = username.toLowerCase();
  if (lower.length < 3) throw httpsError("invalid-argument", "Username must be at least 3 characters long.");
  if (lower.length > 30) throw httpsError("invalid-argument", "Username must be less than 30 characters long.");
  if (!USERNAME_REGEX.test(username))
    throw httpsError("invalid-argument", "Username can only contain letters, numbers, underscores, and dots.");
  if (RESERVED_USERNAMES.has(lower)) throw httpsError("invalid-argument", "This username is reserved and cannot be used.");
  return lower;
}

async function createUserProfile(env: Env, uid: string, data: any, signupBonus: number) {
  const db = getDb(env);
  const ts = now();
  // Reject duplicates before writing (defense-in-depth with the DB unique index).
  await assertIdentifiersAvailable(env, uid, {
    username: data.username,
    email: data.email,
    phone: data.phone,
  });
  await db
    .insert(schema.users)
    .values({
      uid,
      email: data.email ? String(data.email).toLowerCase() : null,
      username: data.username ? String(data.username).toLowerCase() : null,
      fullName: data.fullName ?? null,
      profileImageUrl: data.avatarUrl ?? null,
      dob: data.dob ?? null,
      phone: normalizePhone(data.phone),
      occupation: data.occupation ?? null,
      gender: data.gender ?? null,
      platform: data.platform ?? "unknown",
      coordinates: data.coordinates ?? null,
      dpcoin: signupBonus,
      xp: 0,
      level: 1,
      signupCompleted: true,
      createdAt: ts,
      updatedAt: ts,
    })
    .onConflictDoUpdate({
      target: schema.users.uid,
      set: {
        email: data.email ? String(data.email).toLowerCase() : null,
        username: data.username ? String(data.username).toLowerCase() : null,
        fullName: data.fullName ?? null,
        profileImageUrl: data.avatarUrl ?? null,
        updatedAt: ts,
        signupCompleted: true,
      },
    });

  if (signupBonus > 0) {
    await db.insert(schema.coinTransactions).values({
      id: newId(),
      uid,
      amount: signupBonus,
      type: "signup_bonus",
      description: "Welcome bonus for joining TopHunt!",
      createdAt: ts,
    });
  }
}

export const authRoute = new Hono<{ Bindings: Env; Variables: Variables }>();

authRoute.use("*", optionalAuth);

authRoute.post("/", async (c) => {
  const body = await c.req.json<any>().catch(() => ({}));
  const action = body?.action;
  if (!action) throw httpsError("invalid-argument", "Request must specify an 'action'.");
  const env = c.env;
  const db = getDb(env);
  const uid = c.get("user")?.uid;
  const ip = clientIp(c.req.raw.headers);

  switch (action) {
    case "check": {
      // Availability lookups are unauthenticated → cap per IP to blunt bulk
      // account enumeration while still allowing normal signup typing.
      await rateLimit(env, `check:${ip}`, 40, 60);
      const { type } = body;
      if (!type || !["email", "phone", "username"].includes(type))
        throw httpsError("invalid-argument", "Type must be 'email', 'phone', or 'username'.");
      let value = body.value?.trim();
      if (!value) throw httpsError("invalid-argument", `Missing value for ${type}`);

      if (type === "phone") {
        value = normalizePhone(value);
        if (!value) throw httpsError("invalid-argument", "Invalid phone format");
      } else if (type === "username") {
        value = validateUsername(value);
      } else {
        value = value.toLowerCase();
        if (isDisposableEmail(value)) throw httpsError("invalid-argument", "Disposable email blocked.");
      }

      let exists = false;
      if (type === "email") exists = (await getUserByEmail(env, value)) !== null;
      if (!exists) {
        const col =
          type === "email" ? schema.users.email : type === "phone" ? schema.users.phone : schema.users.username;
        const row = await db.select({ uid: schema.users.uid }).from(schema.users).where(eq(col, value)).get();
        exists = !!row;
      }
      return c.json({ exists });
    }

    case "create": {
      // Account creation is expensive (Firebase user + profile) and unauthenticated.
      await rateLimit(env, `create:${ip}`, 10, 3600);
      const { email, password, username, avatarUrl } = body;
      if (!email || !password || !username)
        throw httpsError("invalid-argument", "Email, password, and username are required.");
      if (isDisposableEmail(email)) throw httpsError("invalid-argument", "Disposable email blocked.");
      // Enforce the canonical password policy server-side — client validation is
      // bypassable, so this is the only real guarantee.
      validatePasswordStrength(password);
      const validatedUsername = validateUsername(username);

      const newUid = await createAuthUser(env, {
        email,
        password,
        displayName: validatedUsername,
        photoUrl: avatarUrl || null,
      });

      try {
        const reward = await getRewardSettings(env);
        await createUserProfile(env, newUid, { ...body, username: validatedUsername }, reward.signupBonus || 0);
        return c.json({ status: "success", uid: newUid, message: "User created successfully" });
      } catch (e) {
        // roll back the auth user if the profile write fails
        const { deleteAuthUser } = await import("../lib/firebaseAdmin");
        await deleteAuthUser(env, newUid).catch(() => {});
        throw httpsError("internal", "Firestore profile creation failed.");
      }
    }

    case "createProfile": {
      // SECURITY: the profile uid MUST come from the verified ID token, never
      // from the request body. Previously this trusted `body.uid` whenever no
      // token was present, letting an unauthenticated caller create or OVERWRITE
      // any user's profile (email/username/avatar) by guessing their uid — an
      // IDOR / account-takeover vector.
      if (!uid) throw httpsError("unauthenticated", "User must be authenticated.");
      if (body.email && isDisposableEmail(body.email))
        throw httpsError("invalid-argument", "Disposable email blocked.");
      const reward = await getRewardSettings(env);
      await createUserProfile(env, uid, body, reward.signupBonus || 0);
      return c.json({ status: "success", uid, message: "Profile created successfully" });
    }

    case "getUserByIdentifier": {
      await rateLimit(env, `identifier:${ip}`, 20, 60);
      const { identifier, type } = body;
      if (!identifier || !type) throw httpsError("invalid-argument", "Identifier and type are required.");
      let value = identifier;
      const col = type === "phone" ? schema.users.phone : schema.users.email;
      if (type === "phone") {
        value = normalizePhone(identifier);
        if (!value) throw httpsError("invalid-argument", "Invalid phone format.");
      } else value = identifier.toLowerCase();

      const row = await db
        .select({
          uid: schema.users.uid,
          fullName: schema.users.fullName,
          username: schema.users.username,
          profileImageUrl: schema.users.profileImageUrl,
        })
        .from(schema.users)
        .where(eq(col, value))
        .get();
      if (!row) return c.json({ found: false });
      return c.json({
        found: true,
        user: { uid: row.uid, name: row.fullName || row.username, avatar: row.profileImageUrl || null },
      });
    }

    // ---- Forgot-password OTP (SMS) ----
    case "sendOtpToPhone": {
      const normalizedPhone = normalizePhone(body.phone);
      if (!normalizedPhone) throw httpsError("invalid-argument", "Invalid phone format.");
      // Abuse controls: per-IP burst cap + strict per-number cooldown so this
      // can't be used as an SMS bomber (real Twilio spend) or a resend spammer.
      await rateLimit(env, `otpsend:${ip}`, 15, 3600);
      await enforceSendCooldown(env, "pwreset", normalizedPhone, OTP_SEND_COOLDOWN);

      // Anti-enumeration: only actually send an SMS if the phone belongs to a
      // real account, but ALWAYS return the same generic success so a caller
      // can't tell whether the number is registered.
      const owner = await db
        .select({ uid: schema.users.uid })
        .from(schema.users)
        .where(eq(schema.users.phone, normalizedPhone))
        .get();
      if (owner) {
        const otp = generateOtp();
        await setOtp(env, "pwreset", normalizedPhone, { otp, createdAt: now() });
        await markSent(env, "pwreset", normalizedPhone, OTP_SEND_COOLDOWN);
        await sendSms(env, normalizedPhone, `Your Password Reset OTP is: ${otp}. Valid for 10 minutes.`);
      }
      return c.json({ success: true });
    }
    case "verifyOtp": {
      const normalizedPhone = normalizePhone(body.phone);
      if (!normalizedPhone || !body.code) throw httpsError("invalid-argument", "Phone and code are required.");
      // Hardened: attempt-limited, single-use, constant-time compare.
      await verifyOtp(env, "pwreset", normalizedPhone, body.code);
      // Server-set proof that the code matched. updatePasswordWithPhone requires
      // this flag, so knowing only the phone number is NOT enough to reset.
      await env.OTP_KV.put(pwVerifiedKey(normalizedPhone), "1", { expirationTtl: PWRESET_VERIFIED_TTL });
      return c.json({ success: true });
    }
    case "updatePasswordWithPhone": {
      const normalizedPhone = normalizePhone(body.phone);
      if (!normalizedPhone || !body.newPassword)
        throw httpsError("invalid-argument", "Phone and password required.");
      // Same canonical policy as signup — no weaker rule for reset.
      validatePasswordStrength(body.newPassword);
      // SECURITY: require a prior SUCCESSFUL OTP verification (server-set flag),
      // not merely the existence of an OTP request. Previously this only checked
      // that an OTP record existed, allowing account takeover by anyone who knew
      // the victim's phone number.
      const verified = await env.OTP_KV.get(pwVerifiedKey(normalizedPhone));
      if (!verified) throw httpsError("permission-denied", "OTP verification required.");
      const row = await db
        .select({ uid: schema.users.uid })
        .from(schema.users)
        .where(eq(schema.users.phone, normalizedPhone))
        .get();
      if (!row) throw httpsError("not-found", "User not found.");
      await updateAuthUser(env, row.uid, { password: body.newPassword });
      await env.OTP_KV.delete(pwVerifiedKey(normalizedPhone));
      return c.json({ success: true });
    }

    // ---- Email change OTP ----
    case "sendEmailOtp": {
      if (!uid) throw httpsError("unauthenticated", "User must be logged in.");
      if (!body.newEmail) throw httpsError("invalid-argument", "New email is required.");
      await rateLimit(env, `emailotp:${uid}`, 10, 3600);
      await enforceSendCooldown(env, "email", uid, OTP_SEND_COOLDOWN);
      const otp = generateOtp();
      await setOtp(env, "email", uid, { otp, newEmail: body.newEmail, createdAt: now() });
      await markSent(env, "email", uid, OTP_SEND_COOLDOWN);
      await sendEmail(env, {
        to: body.newEmail,
        subject: "Verify your new email address",
        text: `Your OTP for email update is: ${otp}. It will expire in 10 minutes.`,
        html: `<h3>Email Verification</h3><p>Your OTP for updating your email address is: <b>${otp}</b></p>`,
      });
      return c.json({ success: true });
    }
    case "verifyEmailOtp": {
      if (!uid) throw httpsError("unauthenticated", "User must be logged in.");
      if (!body.otp) throw httpsError("invalid-argument", "OTP is required.");
      const rec = await verifyOtp(env, "email", uid, body.otp);
      const newEmail = rec.newEmail as string;
      await updateAuthUser(env, uid, { email: newEmail });
      await db.update(schema.users).set({ email: newEmail, updatedAt: now() }).where(eq(schema.users.uid, uid));
      return c.json({ success: true, email: newEmail });
    }

    // ---- Phone change OTP ----
    case "sendPhoneOtp": {
      if (!uid) throw httpsError("unauthenticated", "User must be logged in.");
      if (!body.newPhone) throw httpsError("invalid-argument", "New phone number is required.");
      const newPhone = normalizePhone(body.newPhone);
      if (!newPhone) throw httpsError("invalid-argument", "Invalid phone format.");
      await rateLimit(env, `phoneotp:${uid}`, 10, 3600);
      await enforceSendCooldown(env, "phone", uid, OTP_SEND_COOLDOWN);
      const otp = generateOtp();
      await setOtp(env, "phone", uid, { otp, newPhone, createdAt: now() });
      await markSent(env, "phone", uid, OTP_SEND_COOLDOWN);
      await sendSms(env, newPhone, `Your TopHunt OTP for phone number update is: ${otp}.`);
      return c.json({ success: true });
    }
    case "verifyPhoneOtp": {
      if (!uid) throw httpsError("unauthenticated", "User must be logged in.");
      if (!body.otp) throw httpsError("invalid-argument", "OTP is required.");
      const rec = await verifyOtp(env, "phone", uid, body.otp);
      const newPhone = normalizePhone(rec.newPhone as string);
      await db.update(schema.users).set({ phone: newPhone, updatedAt: now() }).where(eq(schema.users.uid, uid));
      return c.json({ success: true, phone: newPhone });
    }

    default:
      throw httpsError("invalid-argument", `Unknown action: ${action}`);
  }
});
