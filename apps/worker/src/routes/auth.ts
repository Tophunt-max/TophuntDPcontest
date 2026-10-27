/**
 * /auth — port of apps/functions/src/auth/authHandler.ts (the callable
 * `authHandler`). Same action-based contract: POST { action, ...data }.
 * Firebase Auth stays the source of truth (via Identity Toolkit REST).
 */
import { Hono } from "hono";
import { eq, and, sql } from "drizzle-orm";
import type { Env, Variables } from "../types";
import { getDb, schema } from "../db";
import { httpsError } from "../lib/http";
import { optionalAuth } from "../middleware/auth";
import {
  createAuthUser,
  createCustomToken,
  getUserByEmail,
  lookupAuthUser,
  updateAuthUser,
  deleteAuthUser,
} from "../lib/firebaseAdmin";
import { invalidateAuthState } from "../lib/cache";
import { getAppConfig, getAppControlConfig, getAuthMethods, getRewardSettings } from "../lib/settings";
import { lockedPart } from "../lib/rewardLocking";
import { appControlGate } from "../lib/appControl";
import { assertLoginAllowed, assertSignupAllowed, normalizePlatform, signupMethodForProvider, type AuthMethodKey } from "../lib/authMethods";
import { setOtp, generateOtp, verifyOtp, deleteOtp } from "../lib/otp";
import { validatePasswordStrength } from "../lib/password";
import { rateLimit, enforceSendCooldown, markSent, clearSendCooldown, clientIp } from "../lib/rateLimit";
import { edgeLimit } from "../lib/edgeLimit";
import { assertIdentifiersAvailable, assertUsernameNotOnHold, validateUsername } from "../lib/userIdentifiers";
import { revokeAllSessions } from "../lib/sessionRevocation";
import {
  confirmEmailChange,
  confirmPhoneChange,
  requestEmailChange,
  requestPhoneChange,
} from "../lib/identifierChange";

/** Per-recipient cooldown between OTP sends (seconds). */
const OTP_SEND_COOLDOWN = 60;

/** How long a successful password-reset OTP verification stays valid before the
 * password must actually be changed. */
const PWRESET_VERIFIED_TTL = 10 * 60;
const pwVerifiedKey = (phone: string) => `pwverified:${phone}`;
import { sendSms, smsConfigured } from "../lib/sms";
import { sendEmail } from "../lib/email";
import { welcomeEmail } from "../lib/emailTemplates";
import {
  getVerificationRewardConfig,
  registrationLedgerId,
  signupGrant,
  tryCreditVerificationReward,
} from "../lib/verificationReward";
import { now } from "../lib/ids";
import { qualifyReferral } from "../lib/referralProgram";

const DISPOSABLE_DOMAINS = new Set([
  "yopmail.com", "mailinator.com", "temp-mail.org", "10minutemail.com",
  "guerrillamail.com", "sharklasers.com", "maildrop.cc", "getnada.com",
  "dispostable.com", "tempmail.com", "throwawaymail.com", "mail.tm",
  "temp-mail.io", "yopmail.net", "cool.fr.nf", "jetable.org", "temporarily.de",
  "tempmailo.com", "smailpro.com", "trashmail.com", "luxusmail.org",
]);
// The username policy (reserved names, charset, length) is shared with every
// other write path that can set a username — see lib/userIdentifiers.ts.

function normalizePhone(phone?: string | null): string | null {
  if (!phone) return null;
  return phone.replace(/[^\d+]/g, "").trim() || null;
}
function isDisposableEmail(email: string): boolean {
  const domain = email.split("@")[1];
  return domain ? DISPOSABLE_DOMAINS.has(domain.toLowerCase()) : false;
}
/**
 * Attempt the verification completion credit after a successful proof. Never
 * fails the verification itself: the proof is already committed, and the credit
 * is retried idempotently by the next status refresh / claim.
 */
async function creditAfterVerification(env: Env, uid: string) {
  // Referral: email AND mobile verified may qualify a pending referral.
  await qualifyReferral(env, uid, "verified");
  try {
    const r = await tryCreditVerificationReward(env, uid);
    return { credited: r.credited, coins: r.coins, reason: r.reason };
  } catch (e) {
    console.error("[auth] verification reward attempt failed (will retry)", uid, e);
    return { credited: false, coins: 0, reason: "retry_later" };
  }
}

async function createUserProfile(
  env: Env,
  uid: string,
  data: any,
  legacySignupBonus: number,
  signup: {
    method: AuthMethodKey | null;
    provider: string | null;
    /**
     * Identifiers already PROVEN by the sign-in itself (Firebase's own record:
     * a Google-verified email, the phone number an OTP sign-in used). Never
     * taken from the request body.
     */
    verified?: { email?: boolean; phone?: boolean };
  },
) {
  const db = getDb(env);
  const ts = now();
  // With the verification reward enabled, signup credits only the registration
  // reward (default 10) and enrols the account for the completion bonus
  // (default 90, paid once email AND mobile are verified). Disabled: the legacy
  // `rewardSettings.signupBonus` behaviour, unchanged.
  const grant = signupGrant(await getVerificationRewardConfig(env), legacySignupBonus);
  const signupBonus = grant.amount;
  // A free reward like the verification bonus: play-only unless App Control
  // turns `rewardLocking.verification` off (lib/rewardLocking.ts).
  const signupLocked = lockedPart(await getAppConfig(env), "verification", signupBonus);
  // Validate + PRESERVE the typed case for display. Uniqueness stays
  // case-insensitive (assertIdentifiersAvailable + the COLLATE NOCASE index),
  // but the row stores "Alice", not "alice". Idempotent for the `create` path,
  // which already validated.
  const username = data.username ? validateUsername(String(data.username)) : null;
  // Reject duplicates before writing (defense-in-depth with the DB unique index).
  await assertIdentifiersAvailable(env, uid, {
    username,
    email: data.email,
    phone: data.phone,
  });
  // Idempotency: the signup bonus must be granted at most once per uid, even if
  // this runs again on a retried/interrupted signup.
  const existingRow = await db
    .select({ uid: schema.users.uid, signupCompleted: schema.users.signupCompleted })
    .from(schema.users)
    .where(eq(schema.users.uid, uid))
    .get();
  // An INCOMPLETE row (left by the old client auto-create, migration 0061) is
  // still a registration: it gets the welcome grant and the verification
  // enrolment it never received, exactly once. Only a COMPLETED row is "already
  // existed" for the purposes of the grant.
  const alreadyExisted = existingRow?.signupCompleted ? existingRow : undefined;
  // A uid with no COMPLETED profile is registering, so it is held to the admin's
  // sign-up switches (lib/authMethods.ts). A finished account re-running this
  // (a retried request) is not a new signup and is never refused.
  if (!alreadyExisted) {
    assertSignupAllowed(await getAuthMethods(env), signup.method, normalizePlatform(data.platform));
  }

  // The bonus is credited by the `dpcoin` column in the insert below, so its
  // ledger row has to be written in the SAME transaction. It used to be a
  // separate statement afterwards, which meant an interrupted signup could leave
  // a funded account with no ledger entry explaining where the coins came from.
  //
  // Three things make the grant exactly-once:
  //   * `onConflictDoUpdate` below deliberately does NOT set `dpcoin`, so a
  //     repeated signup for an existing uid never re-grants;
  //   * `alreadyExisted` keeps the ledger row out of the repeat case;
  //   * the ledger id is deterministic and the insert ignores conflicts, so even
  //     two concurrent first-signups can only produce one row.
  const bonusLedger =
    !alreadyExisted && signupBonus > 0
      ? db
          .insert(schema.coinTransactions)
          .values({
            id: registrationLedgerId(uid),
            uid,
            amount: signupBonus,
            lockedDelta: signupLocked,
            type: "signup_bonus",
            description: signupLocked > 0 ? "Welcome bonus for joining TopHunt! (Diamond)" : "Welcome bonus for joining TopHunt!",
            createdAt: ts,
          })
          .onConflictDoNothing()
      : null;

  const profileStatements: any[] = [];
  const verifiedCols: Record<string, unknown> = {};
  if (signup.verified?.email && data.email) Object.assign(verifiedCols, { emailVerified: true, emailVerifiedAt: ts });
  if (signup.verified?.phone && data.phone) Object.assign(verifiedCols, { phoneVerified: true, phoneVerifiedAt: ts });

  /**
   * Signup CLAIMS a handle, so any record of a past owner has to go.
   *
   * `assertIdentifiersAvailable` above has already refused the name if it is still
   * inside its hold window, so reaching this line means the handle is legitimately
   * available. What is left behind is a history row from whoever released it — and that
   * row is not harmless. Nothing else deletes it, so it stays dormant (the live owner
   * always outranks history) until this account stops holding the name in a way that
   * records no release, at which point `/@thishandle` starts redirecting to the
   * PREVIOUS owner. Every link shared during this account's ownership would land on a
   * stranger.
   *
   * In the same batch as the insert rather than as a call to
   * `recordUsernameTransition`, because here it costs nothing to be exact: if the
   * signup fails, the row this would have deleted is still protecting the handle.
   */
  if (username) {
    profileStatements.push(
      db.delete(schema.usernameHistory).where(eq(schema.usernameHistory.usernameLower, username.toLowerCase())),
    );
  }

  profileStatements.push(
    db
    .insert(schema.users)
    .values({
      uid,
      email: data.email ? String(data.email).toLowerCase() : null,
      username,
      fullName: data.fullName ?? null,
      profileImageUrl: data.avatarUrl ?? null,
      dob: data.dob ?? null,
      phone: normalizePhone(data.phone),
      occupation: data.occupation ?? null,
      gender: data.gender ?? null,
      platform: data.platform ?? "unknown",
      // How the account was created ("google.com", "password", "custom" = phone …),
      // for the admin's sign-ups-by-method numbers.
      authProvider: signup.provider,
      coordinates: data.coordinates ?? null,
      ...verifiedCols,
      dpcoin: signupBonus,
      lockedCoins: signupLocked,
      xp: 0,
      level: 1,
      signupCompleted: true,
      createdAt: ts,
      updatedAt: ts,
    })
    .onConflictDoUpdate({
      target: schema.users.uid,
      set: {
        // Deliberately does NOT include `dpcoin`: a repeated signup for an
        // existing uid must never re-grant the welcome bonus.
        email: data.email ? String(data.email).toLowerCase() : null,
        username,
        fullName: data.fullName ?? null,
        profileImageUrl: data.avatarUrl ?? null,
        // Completing an incomplete row must store the WHOLE onboarding form —
        // the age gate's date of birth above all — not just the identity fields.
        dob: data.dob ?? null,
        phone: normalizePhone(data.phone),
        occupation: data.occupation ?? null,
        gender: data.gender ?? null,
        authProvider: signup.provider,
        ...verifiedCols,
        updatedAt: ts,
        signupCompleted: true,
      },
    }),
  );
  // An incomplete row left by the old client auto-create never got the welcome
  // grant. Credit it in the SAME batch, guarded on the row still being
  // incomplete, so a concurrent or retried completion cannot pay twice (D1 runs
  // a batch as one transaction, and the upsert below flips the flag).
  if (existingRow && !alreadyExisted && signupBonus > 0) {
    profileStatements.unshift(
      db
        .update(schema.users)
        .set({
          dpcoin: sql`COALESCE(${schema.users.dpcoin}, 0) + ${signupBonus}`,
          lockedCoins: sql`COALESCE(${schema.users.lockedCoins}, 0) + ${signupLocked}`,
        })
        .where(and(eq(schema.users.uid, uid), sql`COALESCE(${schema.users.signupCompleted}, 0) = 0`)),
    );
  }
  if (bonusLedger) profileStatements.push(bonusLedger);
  // Enrolment in the SAME transaction as the profile and the registration
  // credit, and only for a brand-new uid — a repeated signup never enrols (or
  // re-enrols) anyone, and no pre-existing account is ever enrolled.
  if (!alreadyExisted && grant.enrol) {
    profileStatements.push(
      db
        .insert(schema.verificationRewards)
        .values({
          uid,
          registrationReward: signupBonus,
          registrationLedgerId: signupBonus > 0 ? registrationLedgerId(uid) : null,
          completionReward: grant.completionReward,
          createdAt: ts,
          updatedAt: ts,
        })
        .onConflictDoNothing(),
    );
  }
  await db.batch(profileStatements as any);
  // The /api onboarding gate reads `signupCompleted` from the (possibly cached)
  // account state; drop the cached copy so the new account is usable at once.
  await invalidateAuthState(env, uid).catch(() => {});

  // Welcome the new account, best-effort. Only for email signups (phone-only
  // accounts have no address), and never fatal — a signup must not fail because
  // a welcome mail bounced.
  if (data.email) {
    try {
      await sendEmail(env, {
        to: String(data.email).toLowerCase(),
        ...welcomeEmail(data.fullName || data.username || ""),
      });
    } catch (e) {
      console.error("[auth] welcome email failed", uid, e);
    }
  }
}

export const authRoute = new Hono<{ Bindings: Env; Variables: Variables }>();

authRoute.use("*", optionalAuth);

// Backstop over every /auth action, per IP (lib/edgeLimit.ts). Most of these run
// before sign-in, so the IP is the only subject available.
authRoute.use("*", async (c, next) => {
  await edgeLimit(c.env, "AUTH_IP_LIMITER", `auth:${clientIp(c.req.raw.headers)}`, c.header.bind(c));
  await next();
});

authRoute.post("/", async (c) => {
  const body = await c.req.json<any>().catch(() => ({}));
  const action = body?.action;
  if (!action) throw httpsError("invalid-argument", "Request must specify an 'action'.");
  const env = c.env;
  const db = getDb(env);
  const uid = c.get("user")?.uid;
  const ip = clientIp(c.req.raw.headers);

  // No new accounts during maintenance: the app is closed. Sign-in stays open so
  // staff can log in to check it.
  if (action === "create" || action === "createProfile") {
    appControlGate(await getAppControlConfig(env), { action, role: c.get("user")?.role ?? null });
  }

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
        // Username availability is case-insensitive: "Alice" is taken if "alice"
        // exists (matches the COLLATE NOCASE unique index). email/phone are
        // already normalised, so a plain equality is correct for them.
        const predicate =
          type === "username" ? sql`lower(${col}) = lower(${value})` : eq(col, value);
        const row = await db.select({ uid: schema.users.uid }).from(schema.users).where(predicate).get();
        exists = !!row;
      }

      /**
       * A username nobody holds can still be unavailable, and this check has to say so.
       *
       * The query above only looks at `users`, so a handle inside its 30-day hold window
       * reported `{exists: false}` — and then the write refused it with "Username is
       * already in use." The client tells the user the name is free, they finish signing
       * up or renaming, and the request fails on the last step for a reason nothing had
       * hinted at. An availability check that disagrees with the claim path is worse than
       * no check at all.
       *
       * `assertUsernameNotOnHold` is the right thing to call rather than a fresh query,
       * because it is the same code the write uses — and it deliberately declines to say
       * WHO held the name or when it frees up, which keeps this endpoint from becoming a
       * monitor for handles about to become available. `exists` collapses both reasons
       * into "not available", which is all a signup form can act on anyway.
       *
       * Passing the CALLER's uid (or "" when unauthenticated) preserves the owner
       * exemption: someone checking whether they can take their own just-released handle
       * back is correctly told yes.
       */
      if (!exists && type === "username") {
        try {
          await assertUsernameNotOnHold(env, c.get("user")?.uid ?? "", value);
        } catch {
          exists = true;
        }
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
      // Refuse BEFORE minting a Firebase identity when email sign-up is switched
      // off, so a closed door does not leave orphan auth accounts behind.
      assertSignupAllowed(await getAuthMethods(env), "emailSignup", normalizePlatform(body.platform));

      // Idempotent create: if a previous attempt was interrupted (e.g. the auth
      // user was created but the profile write or client sign-in failed), a
      // retry with the SAME email must not dead-end on EMAIL_EXISTS. We adopt an
      // existing auth account ONLY when it has no completed profile yet (i.e. an
      // orphan from a failed attempt) and re-set its password to the caller's,
      // so a real, completed account can never be taken over.
      let newUid: string;
      let createdFresh = false;
      try {
        newUid = await createAuthUser(env, {
          email,
          password,
          displayName: validatedUsername,
          photoUrl: avatarUrl || null,
        });
        createdFresh = true;
      } catch (e: any) {
        if (e?.code !== "already-exists") throw e;
        const existingUid = await getUserByEmail(env, email);
        if (!existingUid) throw httpsError("already-exists", "Email already registered.");
        const existingProfile = await db
          .select({ signupCompleted: schema.users.signupCompleted })
          .from(schema.users)
          .where(eq(schema.users.uid, existingUid))
          .get();
        if (existingProfile?.signupCompleted)
          throw httpsError("already-exists", "Email already registered.");
        // Orphaned/incomplete auth account → safe to resume this signup.
        await updateAuthUser(env, existingUid, { password });
        newUid = existingUid;
      }

      try {
        const reward = await getRewardSettings(env);
        // No phone at signup: a number typed into the form is unproven. It is added
        // (and verified by OTP) later from Edit Profile.
        await createUserProfile(env, newUid, { ...body, phone: null, username: validatedUsername }, reward.signupBonus || 0, {
          method: "emailSignup",
          provider: "password",
        });
        return c.json({ status: "success", uid: newUid, message: "User created successfully" });
      } catch (e: any) {
        // Roll back ONLY an auth user we freshly minted in this call — never an
        // adopted pre-existing account.
        if (createdFresh) await deleteAuthUser(env, newUid).catch(() => {});
        // Preserve friendly ApiError codes (e.g. "Username is already in use.")
        // instead of masking them as a generic internal error.
        if (e?.code) throw e;
        throw httpsError("internal", "Profile creation failed.");
      }
    }

    case "createProfile": {
      // SECURITY: the profile uid MUST come from the verified ID token, never
      // from the request body. Previously this trusted `body.uid` whenever no
      // token was present, letting an unauthenticated caller create or OVERWRITE
      // any user's profile (email/username/avatar) by guessing their uid — an
      // IDOR / account-takeover vector.
      if (!uid) throw httpsError("unauthenticated", "User must be authenticated.");
      await rateLimit(env, `createprofile:${uid}`, 20, 3600);
      // The provider comes from the verified token, never from the body.
      const provider = c.get("user")?.signInProvider ?? null;
      // Email and phone come from Firebase's record of THIS sign-in, never from
      // the body. Onboarding no longer asks for them: an identifier typed into a
      // signup form is unproven, and storing it let anyone squat someone else's
      // number or address (the real owner then found it "already registered").
      // Anything else is added — and verified by OTP — later, from Edit Profile.
      let authRecord: Awaited<ReturnType<typeof lookupAuthUser>> = null;
      try {
        authRecord = await lookupAuthUser(env, uid);
      } catch (e) {
        console.error("[auth] createProfile: auth lookup failed", uid, e);
        throw httpsError("unavailable", "Could not finish creating your profile. Please try again.");
      }
      if (!authRecord) throw httpsError("unauthenticated", "User must be authenticated.");
      const email = authRecord.email ? authRecord.email.toLowerCase() : null;
      if (email && isDisposableEmail(email)) throw httpsError("invalid-argument", "Disposable email blocked.");
      const phone = authRecord.phoneNumber ? normalizePhone(authRecord.phoneNumber) : null;
      const reward = await getRewardSettings(env);
      await createUserProfile(env, uid, { ...body, email, phone }, reward.signupBonus || 0, {
        method: signupMethodForProvider(provider),
        provider,
        verified: {
          // A social provider's verified address, and the number an OTP sign-in
          // just proved. A password account verifies its email by link/OTP later.
          email: provider !== "password" && authRecord.emailVerified,
          // Only our phone-OTP sign-in ("custom" token) proves the number.
          phone: provider === "custom" && !!phone,
        },
      });
      return c.json({ status: "success", uid, message: "Profile created successfully" });
    }

    case "getUserByIdentifier": {
      // Unauthenticated identity lookup (email/phone -> uid, name, avatar), and no
      // app screen calls it. Kept tight and fail-CLOSED: a limiter outage must not
      // turn it into a bulk phone-number de-anonymisation oracle.
      await rateLimit(env, `identifier:${ip}`, 10, 60, { failClosed: true });
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

    // ---- Phone sign-in (OTP -> Firebase custom token) ----
    /**
     * Send a login code to a phone number.
     *
     * Separate from `sendOtpToPhone` (password reset) so the two cannot be used
     * against each other: a code issued for a reset must not sign anybody in, and
     * a login code must not authorise a password change. They use different OTP
     * scopes and different cooldown keys.
     *
     * Unlike password reset, this deliberately does NOT require an existing
     * account — verifying a phone number is how new users sign up here. It still
     * returns the same response either way, so it is not a registration oracle.
     */
    case "sendPhoneLoginOtp": {
      const normalizedPhone = normalizePhone(body.phone);
      if (!normalizedPhone || !/^\+?\d{7,15}$/.test(normalizedPhone)) {
        throw httpsError("invalid-argument", "Enter a valid phone number.");
      }
      // Phone sign-in switched off by an admin: no code is sent (no SMS spend).
      assertLoginAllowed(await getAuthMethods(env), "phone", normalizePlatform(body.platform));
      // Each SMS costs real money, so the caps here are about spend as much as
      // security: per-IP burst, per-number cooldown, and a per-number daily cap.
      await rateLimit(env, `loginotp:${ip}`, 15, 3600, { failClosed: true });
      await rateLimit(env, `loginotp_num:${normalizedPhone}`, 8, 86_400, { failClosed: true });
      await enforceSendCooldown(env, "phone", normalizedPhone, OTP_SEND_COOLDOWN);

      const otp = generateOtp();
      await setOtp(env, "phone", `login:${normalizedPhone}`, { otp, createdAt: now() });
      await markSent(env, "phone", normalizedPhone, OTP_SEND_COOLDOWN);
      const sent = await sendSms(
        env,
        normalizedPhone,
        `${otp} is your TopHunt login code. It expires in 10 minutes. Do not share it with anyone.`,
        otp,
      );
      // Be honest when delivery failed: silently returning success here made
      // "the OTP never arrived" indistinguishable from a wrong number.
      if (!sent) {
        // Clear the cooldown that `markSent` started BEFORE the send, so the user
        // can retry at once instead of being told to wait 60s for a code that was
        // never dispatched. The cooldown has to be set before the send to close a
        // double-send race, which is why it needs undoing here.
        await clearSendCooldown(env, "phone", normalizedPhone);
        throw httpsError(
          "internal",
          "We couldn't send the code right now. Please try again in a moment.",
        );
      }
      return c.json({ success: true, cooldownSeconds: OTP_SEND_COOLDOWN });
    }

    /**
     * Verify a login code and return a Firebase custom token.
     *
     * This replaces client-side Firebase phone auth, which depended on an
     * unmaintained reCAPTCHA package (and a WebView dependency that is not even
     * installed, so it could not work on a real device) and bypassed all of our
     * own OTP rate limiting.
     *
     * The client exchanges the returned token via `signInWithCustomToken`.
     */
    case "phoneSignIn": {
      const normalizedPhone = normalizePhone(body.phone);
      if (!normalizedPhone || !/^\+?\d{7,15}$/.test(normalizedPhone) || !body.code) {
        throw httpsError("invalid-argument", "Phone number and code are required.");
      }
      await rateLimit(env, `phonesignin:${normalizedPhone}`, 15, 3600, { failClosed: true });
      await rateLimit(env, `phonesignin_ip:${ip}`, 40, 3600, { failClosed: true });
      const authMethods = await getAuthMethods(env);
      const platform = normalizePlatform(body.platform);
      // Checked before the code is consumed, so a refused attempt keeps it valid.
      assertLoginAllowed(authMethods, "phone", platform);

      // Single-use, attempt-limited, constant-time compared, fixed lifetime.
      await verifyOtp(env, "phone", `login:${normalizedPhone}`, String(body.code));

      const existing = await db
        .select({ uid: schema.users.uid, signupCompleted: schema.users.signupCompleted, isBlocked: schema.users.isBlocked, status: schema.users.status })
        .from(schema.users)
        .where(eq(schema.users.phone, normalizedPhone))
        .get();

      if (existing?.isBlocked || existing?.status === "blocked") {
        throw httpsError("permission-denied", "This account has been blocked.");
      }
      // A deleted account's phone number is cleared, so this cannot resurrect one.
      if (existing?.status === "deleted") {
        throw httpsError("permission-denied", "This account has been deleted.");
      }

      let uid = existing?.uid;
      let isNewUser = false;

      if (!uid) {
        // An unknown number is a sign-up. Refused AFTER the code is verified, so
        // only the number's owner learns that registration is closed (this is
        // not a "which numbers are registered" oracle).
        assertSignupAllowed(authMethods, "phone", platform);
        // Create the Firebase identity now so the custom token has a subject; the
        // D1 profile is created by `createProfile` once the user finishes signup.
        uid = await createAuthUser(env, { phone: normalizedPhone });
        isNewUser = true;
      } else {
        // Signing in with a code sent to this number proves control of it, so the
        // number is now verified. Best-effort: a login must never fail on this,
        // and the identifier-change flow is the other place that sets the flag.
        try {
          await db
            .update(schema.users)
            .set({ phoneVerified: true, phoneVerifiedAt: now() })
            .where(eq(schema.users.uid, uid));
        } catch (e) {
          console.error("[auth] phoneSignIn: could not mark phone verified", uid, e);
        }
        await creditAfterVerification(env, uid);
      }

      const customToken = await createCustomToken(env, uid);
      return c.json({
        success: true,
        customToken,
        uid,
        isNewUser,
        signupCompleted: !isNewUser && !!existing?.signupCompleted,
        phone: normalizedPhone,
      });
    }

    // ---- Forgot-password OTP (SMS) ----
    case "sendOtpToPhone": {
      const normalizedPhone = normalizePhone(body.phone);
      if (!normalizedPhone || !/^\+?\d{7,15}$/.test(normalizedPhone))
        throw httpsError("invalid-argument", "Enter a valid phone number.");
      // Abuse controls, matched to sendPhoneLoginOtp because both spend real SMS
      // money: per-IP burst, per-number DAILY cap, and a per-number cooldown — all
      // fail-closed, so a KV outage cannot remove the spend limits. The per-number
      // daily cap was missing here, so a registered number could be texted roughly
      // once a minute all day; the per-IP cap was also not fail-closed.
      await rateLimit(env, `otpsend:${ip}`, 15, 3600, { failClosed: true });
      await rateLimit(env, `otpsend_num:${normalizedPhone}`, 8, 86_400, { failClosed: true });
      await enforceSendCooldown(env, "pwreset", normalizedPhone, OTP_SEND_COOLDOWN);

      // A misconfigured gateway is NOT the same thing as an unknown number, and
      // must not hide behind the anti-enumeration success below. With no gateway
      // the code is stored, "we sent you a code" is returned, and the client
      // walks the user to an OTP screen to wait for an SMS that can never
      // arrive — a dead end with no diagnostic anywhere. This reveals nothing
      // about the account: it is a property of the deployment, not of the phone
      // number, and it is returned for every input alike.
      if (!(await smsConfigured(env))) {
        console.error("[auth] sendOtpToPhone: no SMS gateway configured");
        throw httpsError(
          "failed-precondition",
          "SMS is temporarily unavailable. Please reset your password using your email instead.",
        );
      }

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
        const sent = await sendSms(env, normalizedPhone, `${otp} is your TopHunt password reset code. Valid for 10 minutes.`, otp);
        // A delivery failure to a REGISTERED number was reported as success, so
        // the user was walked to the code screen to wait for an SMS that never
        // came. Report it, and clear the cooldown + code so the retry is
        // immediate. This does not weaken anti-enumeration: an UNKNOWN number
        // never reaches here and still returns the same generic success below.
        if (!sent) {
          await Promise.all([
            deleteOtp(env, "pwreset", normalizedPhone),
            clearSendCooldown(env, "pwreset", normalizedPhone),
          ]);
          throw httpsError(
            "internal",
            "We couldn't send the code right now. Please try again in a moment.",
          );
        }
      }
      return c.json({ success: true });
    }
    case "verifyOtp": {
      const normalizedPhone = normalizePhone(body.phone);
      if (!normalizedPhone || !/^\+?\d{7,15}$/.test(normalizedPhone) || !body.code)
        throw httpsError("invalid-argument", "Phone and code are required.");
      // The per-code 5-attempt counter caps guesses against ONE code; these caps
      // bound guessing across codes (request a new one, guess 5 more, repeat)
      // and across accounts from one source. Fail closed: an outage of the
      // counter store must not open credential brute-forcing.
      await rateLimit(env, `otpverify:${normalizedPhone}`, 15, 3600, { failClosed: true });
      await rateLimit(env, `otpverify_ip:${clientIp(c.req.raw.headers)}`, 40, 3600, { failClosed: true });
      // Hardened: attempt-limited, single-use, constant-time compare.
      await verifyOtp(env, "pwreset", normalizedPhone, body.code);
      // Server-set proof that the code matched. updatePasswordWithPhone requires
      // this flag, so knowing only the phone number is NOT enough to reset.
      await env.OTP_KV.put(pwVerifiedKey(normalizedPhone), "1", { expirationTtl: PWRESET_VERIFIED_TTL });
      return c.json({ success: true });
    }
    case "updatePasswordWithPhone": {
      const normalizedPhone = normalizePhone(body.phone);
      if (!normalizedPhone || !/^\+?\d{7,15}$/.test(normalizedPhone) || !body.newPassword)
        throw httpsError("invalid-argument", "Phone and password required.");
      await rateLimit(env, `pwreset:${normalizedPhone}`, 10, 3600, { failClosed: true });
      await rateLimit(env, `pwreset_ip:${clientIp(c.req.raw.headers)}`, 30, 3600, { failClosed: true });
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
      /**
       * End every existing session. This is the clearest case in the whole codebase for
       * doing so.
       *
       * The person calling this is SIGNED OUT — that is the premise of the flow — so
       * there is no session here worth preserving, and every session that does exist
       * belongs to a device that was signed in before the password was reset. That
       * includes whoever the reset is a response to. Until now a phone-OTP recovery gave
       * the real owner their password back while leaving the intruder exactly where they
       * were: it restored access without restoring control.
       *
       * Awaited and allowed to throw, unlike the best-effort revocations elsewhere. The
       * caller is not holding a session that a failure would strand, and silently
       * reporting a successful recovery that did not actually evict anyone is the one
       * outcome this must not produce. A retry is cheap; the OTP proof is deleted only
       * after this succeeds.
       */
      await revokeAllSessions(env, row.uid, "password_reset");
      await env.OTP_KV.delete(pwVerifiedKey(normalizedPhone));
      return c.json({ success: true });
    }

    // ---- Email / phone change ----
    //
    // These four handlers used to inline their own logic and each skipped most of
    // what a credential change needs: no email normalisation or validation, no
    // uniqueness check (so a duplicate 500'd *after* burning the single-use code),
    // no per-target rate limit (so one account could text arbitrary numbers at our
    // expense), no handling of a failed send, no rollback when Firebase and D1
    // disagreed, and nothing telling the OLD address it had been replaced.
    //
    // All of that now lives in ONE place — lib/identifierChange.ts — because the
    // email and phone paths kept drifting apart from each other. See that file's
    // header for the full list of what was wrong and why each part matters.
    case "sendEmailOtp": {
      if (!uid) throw httpsError("unauthenticated", "User must be logged in.");
      const result = await requestEmailChange(env, c.get("user"), body.newEmail, ip);
      return c.json({ success: true, ...result });
    }
    case "verifyEmailOtp": {
      if (!uid) throw httpsError("unauthenticated", "User must be logged in.");
      await rateLimit(env, `emailotpverify:${uid}`, 20, 3600, { failClosed: true });
      const { email, verifyOnly } = await confirmEmailChange(env, c.get("user"), body.otp, c);
      // Proving an identifier may complete the verification reward. The server
      // decides eligibility and amount; the response only reports the outcome.
      const verificationReward = await creditAfterVerification(env, uid);
      return c.json({ success: true, email, verifyOnly, verificationReward });
    }

    case "sendPhoneOtp": {
      if (!uid) throw httpsError("unauthenticated", "User must be logged in.");
      const result = await requestPhoneChange(env, c.get("user"), body.newPhone, ip);
      return c.json({ success: true, ...result });
    }
    case "verifyPhoneOtp": {
      if (!uid) throw httpsError("unauthenticated", "User must be logged in.");
      await rateLimit(env, `phoneotpverify:${uid}`, 20, 3600, { failClosed: true });
      const { phone, verifyOnly } = await confirmPhoneChange(env, c.get("user"), body.otp, c);
      const verificationReward = await creditAfterVerification(env, uid);
      return c.json({ success: true, phone, verifyOnly, verificationReward });
    }

    default:
      throw httpsError("invalid-argument", `Unknown action: ${action}`);
  }
});
