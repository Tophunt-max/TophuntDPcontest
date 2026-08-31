import { eq } from "drizzle-orm";
import type { AuthUser, Env } from "../types";
import { getDb, schema } from "../db";
import { httpsError } from "./http";
import { setOtp, generateOtp, verifyOtp, deleteOtp } from "./otp";
import {
  clearSendCooldown,
  enforceSendCooldown,
  markSent,
  rateLimit,
} from "./rateLimit";
import { assertIdentifiersAvailable, normalizePhone } from "./userIdentifiers";
import { updateAuthUser } from "./firebaseAdmin";
import { sendEmail, emailConfigured } from "./email";
import { sendSms, smsConfigured } from "./sms";
import { createNotification } from "./notify";
import { delCache, userCacheKey } from "./cache";
import { assertRecentAuth, clearReauthGrant } from "./reauth";
import { now } from "./ids";

/**
 * Changing the email address or phone number on an account.
 *
 * These two fields are not profile decoration — they are the CREDENTIALS. The
 * email is what Firebase password reset targets, and `users.phone` is the sole
 * lookup key for phone sign-in and phone password reset (routes/auth.ts
 * `phoneSignIn`, `sendOtpToPhone`, `updatePasswordWithPhone`). Whoever controls
 * them controls the account. So this file exists to make one hardened path the
 * ONLY way either can move.
 *
 * It replaces four handlers that each did roughly two things — verify a code,
 * write the column — and skipped the rest. What was missing, and why each one
 * mattered:
 *
 *  - NO OTP AT ALL FOR PHONE. `updateProfile` listed `phone` among its writable
 *    columns, so `POST /api {action:"updateProfile", phone:"+91…"}` set it
 *    directly. Since D1 is the phone source of truth, that let any session claim
 *    any unclaimed number — and then receive that number's login OTPs and
 *    password resets. That is an account-takeover primitive, not a profile edit.
 *
 *  - NO UNIQUENESS CHECK. `assertIdentifiersAvailable` existed and was called at
 *    signup and on profile edit, but not here. A duplicate therefore surfaced as
 *    a raw `UNIQUE constraint failed` → HTTP 500, *after* the single-use OTP had
 *    been burned and (for email) after the Firebase login had already moved.
 *
 *  - NO EMAIL NORMALISATION OR VALIDATION. Signup trims, lowercases and rejects
 *    disposable domains. This path did none of it, so `" Foo@Mailinator.COM "`
 *    was accepted verbatim — dodging the disposable-domain policy and, because
 *    the unique index is byte-exact rather than NOCASE, creating a second row for
 *    an address that already existed in another case.
 *
 *  - NO ABUSE OR COST CONTROL ON THE TARGET. Every limit was keyed on the
 *    CALLER's uid, so one account could send SMS to ten different arbitrary
 *    numbers an hour, at our expense, and the per-uid cooldown did nothing to
 *    stop it. `sendPhoneLoginOtp` already got this right (per-IP + per-number +
 *    per-number daily cap); this now matches it.
 *
 *  - DELIVERY FAILURE REPORTED AS SUCCESS. `sendEmail`/`sendSms` return a boolean
 *    and never throw. Both call sites ignored it, so a dead provider stored the
 *    code, started the 60s cooldown, returned `{success:true}` and opened the
 *    "enter the code" modal for a code that would never arrive.
 *
 *  - FIREBASE/D1 SPLIT BRAIN. For email, Firebase was updated first and D1
 *    second with no compensation, so a D1 failure left the user signing in with
 *    the new address while their profile showed the old one. For phone, Firebase
 *    was never updated at all, orphaning the old number on the Firebase record —
 *    which then made that number permanently un-signup-able for its next owner
 *    (`PHONE_NUMBER_EXISTS` is not mapped, so it 500s).
 *
 *  - NO SIGNAL TO THE OWNER. Nothing told the OLD address or number that it had
 *    been replaced. A hijacked session could swap the credentials silently, which
 *    is exactly the moment a victim needs to hear from us.
 */

/** Per-recipient cooldown between sends (seconds). Matches routes/auth.ts. */
export const OTP_SEND_COOLDOWN = 60;

/**
 * Disposable domains. Intentionally the same list the signup path uses; a
 * throwaway address is a support liability either way, and a policy that applies
 * only at signup is trivially sidestepped by changing the address afterwards.
 */
const DISPOSABLE_DOMAINS = new Set([
  "yopmail.com", "mailinator.com", "temp-mail.org", "10minutemail.com",
  "guerrillamail.com", "sharklasers.com", "maildrop.cc", "getnada.com",
  "dispostable.com", "tempmail.com", "throwawaymail.com", "mail.tm",
  "temp-mail.io", "yopmail.net", "cool.fr.nf", "jetable.org", "temporarily.de",
  "tempmailo.com", "smailpro.com", "trashmail.com", "luxusmail.org",
]);

/**
 * Deliberately conservative, and NOT trying to implement RFC 5322.
 *
 * A permissive regex here would be worse than a strict one: the address has to
 * survive Identity Toolkit, the email provider, and a byte-exact unique index,
 * and anything exotic enough to disagree with those is better refused up front
 * than accepted and then half-written.
 */
const EMAIL_REGEX = /^[^\s@,;:<>()[\]\\]+@[^\s@.,;:<>()[\]\\]+(\.[^\s@.,;:<>()[\]\\]+)+$/;
const MAX_EMAIL_LENGTH = 254;

/** Trim + lowercase. The single definition of "the same address". */
export function normalizeEmail(raw: unknown): string {
  return String(raw ?? "").trim().toLowerCase();
}

/** Normalise and validate an email, or throw `invalid-argument`. */
export function assertValidEmail(raw: unknown): string {
  const email = normalizeEmail(raw);
  if (!email) throw httpsError("invalid-argument", "Email address is required.");
  if (email.length > MAX_EMAIL_LENGTH) {
    throw httpsError("invalid-argument", "That email address is too long.");
  }
  if (!EMAIL_REGEX.test(email)) {
    throw httpsError("invalid-argument", "Enter a valid email address.");
  }
  const domain = email.split("@")[1];
  if (domain && DISPOSABLE_DOMAINS.has(domain)) {
    throw httpsError("invalid-argument", "Temporary email addresses are not allowed.");
  }
  return email;
}

/**
 * Normalise and validate a phone number, or throw `invalid-argument`.
 *
 * The length check is the part that was missing: `normalizePhone` only strips
 * non-digits, so it returns a truthy value for `"+"` or `"1"`. The change flow
 * accepted those and paid to send an SMS to them, while `sendPhoneLoginOtp` had
 * the `\d{7,15}` guard all along.
 */
export function assertValidPhone(raw: unknown): string {
  const phone = normalizePhone(typeof raw === "string" ? raw : String(raw ?? ""));
  if (!phone || !/^\+?\d{7,15}$/.test(phone)) {
    throw httpsError("invalid-argument", "Enter a valid phone number.");
  }
  return phone;
}

/** Mask an address for display in an alert: `al***@example.com`. */
function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  const head = local.slice(0, 2);
  return `${head}${"*".repeat(Math.max(3, local.length - 2))}@${domain}`;
}

/** Mask a number for display in an alert: `+9198****3210`. */
function maskPhone(phone: string): string {
  if (phone.length <= 4) return "****";
  return `${phone.slice(0, phone.length - 6)}****${phone.slice(-2)}`;
}

interface AccountIdentifiers {
  email: string | null;
  phone: string | null;
}

async function readIdentifiers(env: Env, uid: string): Promise<AccountIdentifiers> {
  const row = await getDb(env)
    .select({ email: schema.users.email, phone: schema.users.phone })
    .from(schema.users)
    .where(eq(schema.users.uid, uid))
    .get();
  if (!row) throw httpsError("not-found", "Account not found.");
  return { email: row.email ?? null, phone: row.phone ?? null };
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

export interface ChangeRequestResult {
  cooldownSeconds: number;
  /** Masked destination, so the client can say where the code went. */
  sentTo: string;
  /**
   * True when the identifier is not moving — the user is proving the one already
   * on the account. The client wording differs ("confirm" vs "change").
   */
  verifyOnly: boolean;
}

/**
 * Send a verification code to a NEW email address.
 *
 * Order matters here. Everything that can be rejected cheaply is checked BEFORE
 * a code is stored or a cooldown is started, so a rejected attempt costs the user
 * nothing — the previous version burned a send slot and a 60-second cooldown on
 * requests that were never going to succeed.
 */
export async function requestEmailChange(
  env: Env,
  user: AuthUser,
  rawEmail: unknown,
  ip: string,
): Promise<ChangeRequestResult> {
  const uid = user.uid;
  const email = assertValidEmail(rawEmail);
  const current = await readIdentifiers(env, uid);

  /**
   * Same address as the one already on the account = PROVE it, don't move it.
   *
   * This used to throw "That is already your email address", which made an
   * unverified address impossible to verify: the only endpoint that could send a
   * code refused to send one to the address that needed it. So an account whose
   * email was never confirmed — the typo at signup, the address Firebase password
   * reset targets — was stuck unverified forever, and the "Not verified" hint the
   * profile screen shows had nothing behind it.
   *
   * Nothing moves on this path, so it deliberately skips the re-authentication
   * gate and the uniqueness check below. Neither has anything to protect: the
   * address is already theirs, the code goes to it rather than to somewhere of the
   * caller's choosing, and the outcome takes nothing away from the account holder.
   */
  const verifyOnly = !!current.email && normalizeEmail(current.email) === email;

  if (!verifyOnly) {
    // Prove it is still the account holder BEFORE anything else. The code below
    // goes to the NEW address, which proves the caller controls that address — it
    // says nothing about whether they own this account. Without this gate, a
    // session of any age could move the credentials to an address of its choosing.
    await assertRecentAuth(env, user);
    // Refuse a taken address up front rather than at confirm time, where the code
    // is already spent and (previously) the Firebase login had already moved.
    await assertIdentifiersAvailable(env, uid, { email });
  }

  // Fail before storing anything if we cannot actually deliver.
  if (!(await emailConfigured(env))) {
    throw httpsError("internal", "Email delivery is not available right now. Please try again later.");
  }

  // Three caps, and the important one is the LAST. The first two protect the
  // account; the third protects the stranger whose inbox an attacker would
  // otherwise point us at. Fail-closed: a KV blip must not remove a spend limit.
  await rateLimit(env, `emailchange:${uid}`, 10, 3600, { failClosed: true });
  await rateLimit(env, `emailchange_ip:${ip}`, 15, 3600, { failClosed: true });
  await rateLimit(env, `emailchange_to:${email}`, 5, 86_400, { failClosed: true });
  // Cooldown on BOTH the caller and the destination. Keying it only on the caller
  // is what allowed one account to walk through many different targets, one per
  // minute, without ever tripping its own cooldown.
  await enforceSendCooldown(env, "email", uid, OTP_SEND_COOLDOWN);
  await enforceSendCooldown(env, "emailto", email, OTP_SEND_COOLDOWN);

  const otp = generateOtp();
  await setOtp(env, "email", uid, { otp, newEmail: email, verifyOnly, createdAt: now() });
  await markSent(env, "email", uid, OTP_SEND_COOLDOWN);
  await markSent(env, "emailto", email, OTP_SEND_COOLDOWN);

  const sent = await sendEmail(env, {
    to: email,
    subject: "Verify your new email address",
    text:
      `${otp} is your TopHunt code to confirm this email address. It expires in 10 minutes.\n\n` +
      `If you did not request this, ignore this email — your address has not been changed.`,
    html:
      `<h3>Confirm your new email address</h3>` +
      `<p>Your code is <b>${otp}</b>. It expires in 10 minutes.</p>` +
      `<p>If you did not request this, you can ignore this email — your address has not been changed.</p>`,
  });

  // Be honest when delivery failed, and leave the user able to retry AT ONCE.
  // Keeping the stored code and the cooldown after a failed send is what turned
  // one provider hiccup into a 60-second dead end, then a one-hour lockout after
  // ten blind retries.
  if (!sent) {
    await Promise.all([
      deleteOtp(env, "email", uid),
      clearSendCooldown(env, "email", uid),
      clearSendCooldown(env, "emailto", email),
    ]);
    throw httpsError("internal", "We couldn't send the code right now. Please try again in a moment.");
  }

  return { cooldownSeconds: OTP_SEND_COOLDOWN, sentTo: maskEmail(email), verifyOnly };
}

/**
 * Confirm the code and move the address.
 *
 * Firebase first, then D1, with a ROLLBACK if D1 refuses. Firebase owns the email
 * for sign-in and password reset, so leaving it moved while D1 still shows the old
 * address is the failure that actually hurts: the user signs in with an address
 * their own profile denies, and support has nothing to go on.
 */
export async function confirmEmailChange(
  env: Env,
  uid: string,
  code: unknown,
): Promise<{ email: string; verifyOnly: boolean }> {
  const db = getDb(env);
  const before = await readIdentifiers(env, uid);
  const rec = await verifyOtp(env, "email", uid, code as string | undefined);
  const email = assertValidEmail(rec.newEmail);
  // Carried on the OTP record rather than recomputed, so a change cannot quietly
  // become a verify-only (or the reverse) if the row moved in between.
  const verifyOnly = rec.verifyOnly === true;

  if (!verifyOnly) {
    // Re-check availability. The code was issued up to ten minutes ago and someone
    // else may have taken the address since — this is the window the send-time
    // check cannot cover.
    await assertIdentifiersAvailable(env, uid, { email });
  }

  const ts = now();
  // Nothing to move, and nothing to roll back, when the address is already ours.
  if (!verifyOnly) await updateAuthUser(env, uid, { email });
  try {
    await db
      .update(schema.users)
      .set({ email, emailVerified: true, emailVerifiedAt: ts, updatedAt: ts })
      .where(eq(schema.users.uid, uid));
  } catch (e) {
    // Put the login back where it was. Without this the account is left in a
    // state no screen can explain and no user can undo.
    if (!verifyOnly && before.email) {
      await updateAuthUser(env, uid, { email: before.email }).catch((rollbackError) =>
        console.error("[identifierChange] email rollback FAILED", uid, rollbackError),
      );
    }
    console.error("[identifierChange] email D1 write failed, rolled back", uid, e);
    throw httpsError("internal", "We couldn't update your email address. Please try again.");
  }

  if (verifyOnly) {
    // No alert and no burned grant: nothing changed, so there is nobody to warn
    // and no credential whose proof has gone stale. Only the cached profile needs
    // dropping, because `emailVerified` is part of what it serves.
    await delCache(env, userCacheKey(uid)).catch(() => {});
  } else {
    await afterIdentifierChange(env, uid, {
      kind: "email",
      oldValue: before.email,
      newValue: email,
    });
  }

  return { email, verifyOnly };
}

// ---------------------------------------------------------------------------
// Phone
// ---------------------------------------------------------------------------

export async function requestPhoneChange(
  env: Env,
  user: AuthUser,
  rawPhone: unknown,
  ip: string,
): Promise<ChangeRequestResult> {
  const uid = user.uid;
  const phone = assertValidPhone(rawPhone);
  const current = await readIdentifiers(env, uid);

  // Same number as the one on file = prove it, don't move it. See the equivalent
  // branch in `requestEmailChange` for why this skips the gate and the uniqueness
  // check.
  const verifyOnly = !!current.phone && normalizePhone(current.phone) === phone;

  if (!verifyOnly) {
    await assertRecentAuth(env, user);
    await assertIdentifiersAvailable(env, uid, { phone });
  }

  if (!(await smsConfigured(env))) {
    throw httpsError("internal", "SMS delivery is not available right now. Please try again later.");
  }

  await rateLimit(env, `phonechange:${uid}`, 10, 3600, { failClosed: true });
  await rateLimit(env, `phonechange_ip:${ip}`, 15, 3600, { failClosed: true });
  // The per-number daily cap. Each SMS is real money and this is the only limit
  // that stops us being used to text a number its owner never gave us.
  await rateLimit(env, `phonechange_to:${phone}`, 5, 86_400, { failClosed: true });
  await enforceSendCooldown(env, "phone", uid, OTP_SEND_COOLDOWN);
  await enforceSendCooldown(env, "phoneto", phone, OTP_SEND_COOLDOWN);

  const otp = generateOtp();
  await setOtp(env, "phone", uid, { otp, newPhone: phone, verifyOnly, createdAt: now() });
  await markSent(env, "phone", uid, OTP_SEND_COOLDOWN);
  await markSent(env, "phoneto", phone, OTP_SEND_COOLDOWN);

  const sent = await sendSms(
    env,
    phone,
    `${otp} is your TopHunt code to confirm this phone number. It expires in 10 minutes. Do not share it with anyone.`,
    otp,
  );
  if (!sent) {
    await Promise.all([
      deleteOtp(env, "phone", uid),
      clearSendCooldown(env, "phone", uid),
      clearSendCooldown(env, "phoneto", phone),
    ]);
    throw httpsError("internal", "We couldn't send the code right now. Please try again in a moment.");
  }

  return { cooldownSeconds: OTP_SEND_COOLDOWN, sentTo: maskPhone(phone), verifyOnly };
}

/**
 * Confirm the code and move the number.
 *
 * D1 first here, unlike email — because for phone, D1 IS the source of truth:
 * `phoneSignIn` resolves the account by `users.phone` and mints a custom token,
 * and Firebase's own `phoneNumber` is not consulted by any login path.
 *
 * Firebase is then synced best-effort. That sync is new: `updateAuthUser` had no
 * `phoneNumber` parameter at all, so the old number stayed attached to the
 * Firebase record forever. The consequence was not cosmetic — the next real owner
 * of that recycled number could never sign up, because creating their Firebase
 * user returned `PHONE_NUMBER_EXISTS` and dead-ended as an unmapped 500. It is
 * best-effort rather than fatal precisely because it is not the login path: a
 * Firebase hiccup must not fail a change whose authoritative write has committed.
 */
export async function confirmPhoneChange(
  env: Env,
  uid: string,
  code: unknown,
): Promise<{ phone: string; verifyOnly: boolean }> {
  const db = getDb(env);
  const before = await readIdentifiers(env, uid);
  const rec = await verifyOtp(env, "phone", uid, code as string | undefined);
  const phone = assertValidPhone(rec.newPhone);
  const verifyOnly = rec.verifyOnly === true;

  if (!verifyOnly) await assertIdentifiersAvailable(env, uid, { phone });

  const ts = now();
  await db
    .update(schema.users)
    .set({ phone, phoneVerified: true, phoneVerifiedAt: ts, updatedAt: ts })
    .where(eq(schema.users.uid, uid));

  if (!verifyOnly) {
    await updateAuthUser(env, uid, { phoneNumber: phone }).catch((e) =>
      console.error("[identifierChange] Firebase phone sync failed (D1 is authoritative)", uid, e),
    );
    await afterIdentifierChange(env, uid, {
      kind: "phone",
      oldValue: before.phone,
      newValue: phone,
    });
  } else {
    await delCache(env, userCacheKey(uid)).catch(() => {});
  }

  return { phone, verifyOnly };
}

// ---------------------------------------------------------------------------
// After the change
// ---------------------------------------------------------------------------

/**
 * Tell the account holder — including at the address they no longer control.
 *
 * This is the only defence a victim has against a session hijack that swaps the
 * credentials. Nothing previously notified anyone: an attacker with a briefly
 * unlocked phone could move the email to their own, and the owner's first
 * indication would be a password reset that no longer worked.
 *
 * Every step is best-effort. The change has already committed, and failing the
 * request now would tell the user their change did not happen when it did.
 */
async function afterIdentifierChange(
  env: Env,
  uid: string,
  change: { kind: "email" | "phone"; oldValue: string | null; newValue: string },
): Promise<void> {
  const label = change.kind === "email" ? "email address" : "phone number";
  const masked =
    change.kind === "email" ? maskEmail(change.newValue) : maskPhone(change.newValue);

  /**
   * Burn the re-authentication grant.
   *
   * The grant was proof of control over the identifier that has just been
   * replaced. Letting it stand would mean one code, sent to an address the user no
   * longer uses, keeps authorising changes for the rest of its ten minutes — so a
   * single compromised inbox could be walked through email, then phone, then
   * deletion. Each credential change re-proves.
   */
  await clearReauthGrant(env, uid);

  // The public profile is served from a shared KV entry, so the old address would
  // keep being returned until its TTL lapsed.
  await delCache(env, userCacheKey(uid)).catch(() => {});

  // In-app, so there is a record inside the account itself.
  await createNotification(env, uid, {
    title: `Your ${label} was changed`,
    body: `Your ${label} is now ${masked}. If this wasn't you, contact support immediately.`,
    type: "admin",
    targetId: uid,
  }).catch((e) => console.error("[identifierChange] notification failed", uid, e));

  if (!change.oldValue) return;

  // And at the address that has just lost control of the account.
  if (change.kind === "email") {
    await sendEmail(env, {
      to: change.oldValue,
      subject: "Your TopHunt email address was changed",
      text:
        `The email address on your TopHunt account was just changed to ${masked}.\n\n` +
        `If you did this, no action is needed. If you did NOT, contact support immediately — ` +
        `someone else may have access to your account.`,
      html:
        `<h3>Your email address was changed</h3>` +
        `<p>The email address on your TopHunt account was just changed to <b>${masked}</b>.</p>` +
        `<p>If you did this, no action is needed. If you did <b>not</b>, contact support ` +
        `immediately — someone else may have access to your account.</p>`,
    }).catch((e) => console.error("[identifierChange] old-email alert failed", uid, e));
  } else {
    await sendSms(
      env,
      change.oldValue,
      `The phone number on your TopHunt account was changed to ${masked}. If this wasn't you, contact support immediately.`,
    ).catch((e) => console.error("[identifierChange] old-phone alert failed", uid, e));
  }
}
