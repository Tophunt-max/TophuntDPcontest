import { eq } from "drizzle-orm";
import type { AuthUser, Env } from "../types";
import { getDb, schema } from "../db";
import { httpsError } from "./http";
import { generateOtp, setOtp, verifyOtp, deleteOtp } from "./otp";
import { clearSendCooldown, enforceSendCooldown, markSent, rateLimit } from "./rateLimit";
import { sendEmail, emailConfigured } from "./email";
import { sendSms, smsConfigured } from "./sms";
import { securityCodeEmail } from "./emailTemplates";
import { now } from "./ids";

/**
 * "Prove it's still you" before an irreversible or credential-level action.
 *
 * Two actions can destroy an account: deleting it, and moving the email or phone
 * number it signs in with. Both were reachable from any session that happened to
 * be signed in, however old. So the practical requirement for taking over an
 * account was a session — a stolen ID token, a phone left unlocked, an account
 * left signed in on a shared device — and nothing between that and the account
 * being gone or the credentials being someone else's.
 *
 * Worth being precise about the gap, because Firebase LOOKS like it covers this
 * and does not. The client SDK refuses a password change on a stale session with
 * `auth/requires-recent-login`, and change-password relies on that. But deletion
 * and identifier changes here do not go through the client SDK at all — they go
 * through our Worker, which calls the Admin REST API, and the Admin API has no
 * notion of recent login. So password changes were protected and account deletion
 * was not, which is exactly backwards.
 *
 * ## The gate
 *
 * `assertRecentAuth` requires ONE of two things:
 *
 *  1. A FRESH SESSION — `auth_time` within the window. Not `iat`: the SDK
 *     refreshes tokens roughly hourly and `iat` moves with it, but `auth_time`
 *     only moves when a human authenticates again. That makes it the one claim an
 *     attacker holding a token cannot refresh, no matter how long they hold it.
 *     A client satisfies this by calling Firebase's own `reauthenticateWithCredential`
 *     (a password prompt, or a Google/Apple re-consent) and then refreshing the
 *     token — the strongest factor available, and it costs us nothing to send.
 *
 *  2. A REAUTH GRANT — the user passed the OTP challenge below. This is the path
 *     for accounts with no password: phone-only, Google-only, Apple-only. Without
 *     it the gate would be unsatisfiable for a large part of the user base, which
 *     would mean either locking them out of deleting their own account (the app
 *     store violation this whole area exists to avoid) or exempting them (a gate
 *     with a hole in it).
 *
 * ## What this does and does not stop
 *
 * Strong against a STOLEN TOKEN or a session left behind on someone else's
 * device: the attacker has the session but not the phone, the inbox, or the
 * password, so neither path opens.
 *
 * Weaker against a physically unlocked handset, because the OTP arrives on that
 * same handset. That case is not fully solvable with a one-device factor and it is
 * not claimed here — what it does buy even then is a deliberate, visible step
 * instead of a silent one, plus the alert to the old identifier that
 * lib/identifierChange.ts now sends. For accounts that do have a password, path 1
 * closes it properly, and the client prefers path 1 whenever one exists.
 */

/**
 * How recently the user must have signed in. Five minutes matches Firebase's own
 * `requires-recent-login` behaviour, so a client that satisfies the SDK satisfies
 * us too and the two cannot disagree about what "recent" means.
 */
export const REAUTH_FRESH_WINDOW_SEC = 5 * 60;

/**
 * How long passing the OTP challenge stays good for.
 *
 * Deliberately a WINDOW rather than a single use. Consuming the grant per action
 * reads stricter, but it would force a second code on the one flow that
 * legitimately performs two credential changes in a row (the edit-profile screen
 * guides email first, then phone), and a flow that asks for repeated codes trains
 * people to approve them without reading. Ten minutes with a hard expiry is the
 * same trade Firebase makes.
 */
export const REAUTH_GRANT_TTL_SEC = 10 * 60;

/** Cooldown between challenge sends, per destination. */
const CHALLENGE_COOLDOWN_SEC = 60;

const grantKey = (uid: string) => `reauth:granted:${uid}`;

export type ReauthMethod = "phone" | "email";

export interface ReauthChallenge {
  method: ReauthMethod;
  /** Masked destination, so the client can say where the code went. */
  sentTo: string;
  cooldownSeconds: number;
}

/** `al***@example.com` */
function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  return `${local.slice(0, 2)}${"*".repeat(Math.max(3, local.length - 2))}@${domain}`;
}

/** `+9198****10` */
function maskPhone(phone: string): string {
  if (phone.length <= 4) return "****";
  return `${phone.slice(0, phone.length - 6)}****${phone.slice(-2)}`;
}

/**
 * Is there an unexpired grant for this user?
 *
 * Fail-CLOSED on a KV error. Every other cache read in the codebase fails open so
 * a blip degrades to a cache miss, but this one is a security decision: treating
 * "we could not check" as "verified" would hand an attacker a way to bypass the
 * gate by making KV unavailable.
 */
export async function hasReauthGrant(env: Env, uid: string): Promise<boolean> {
  try {
    return (await env.OTP_KV.get(grantKey(uid))) !== null;
  } catch (e) {
    console.error("[reauth] grant lookup failed (treating as NOT verified)", uid, e);
    return false;
  }
}

/** Record that the user passed the challenge. */
async function storeReauthGrant(env: Env, uid: string): Promise<void> {
  await env.OTP_KV.put(grantKey(uid), String(now()), { expirationTtl: REAUTH_GRANT_TTL_SEC });
}

/** Drop a grant — used when the credentials it protected have just changed. */
export async function clearReauthGrant(env: Env, uid: string): Promise<void> {
  await env.OTP_KV.delete(grantKey(uid)).catch((e) =>
    console.error("[reauth] grant clear failed", uid, e),
  );
}

/** True when the token itself proves a recent sign-in. */
export function hasFreshSession(user: Pick<AuthUser, "authTime">, nowSec = Date.now() / 1000): boolean {
  // A missing `auth_time` is treated as stale, never as fresh. The claim is
  // standard on Firebase ID tokens, so absence means something is unusual, and
  // "unusual" must not be the case that skips the check.
  if (typeof user.authTime !== "number" || !Number.isFinite(user.authTime)) return false;
  // Clamp future-dated claims: a clock-skewed token must not buy unlimited freshness.
  const age = nowSec - user.authTime;
  return age >= -60 && age <= REAUTH_FRESH_WINDOW_SEC;
}

/** What the client is told when the gate refuses. Matched on by the app. */
export const REAUTH_REQUIRED_CODE = "reauth_required";

/**
 * Require a recent sign-in, or a passed challenge.
 *
 * Throws `failed-precondition` with a message the client matches on to open its
 * re-verification step. Deliberately NOT `unauthenticated`: a 401 is handled
 * globally as an expired session and would sign the user out mid-flow, turning a
 * "confirm it's you" prompt into a logout.
 */
export async function assertRecentAuth(env: Env, user: AuthUser): Promise<void> {
  if (hasFreshSession(user)) return;
  if (await hasReauthGrant(env, user.uid)) return;
  throw httpsError(
    "failed-precondition",
    `${REAUTH_REQUIRED_CODE}: For your security, please confirm it's you before continuing.`,
  );
}

/**
 * Where a challenge can be sent for this account.
 *
 * Phone is preferred over email when both exist: an attacker who has taken over an
 * inbox is a far more common story than one who has taken over a SIM, and the SMS
 * is the factor more likely to still be in the real owner's hands.
 */
export async function reauthOptions(
  env: Env,
  uid: string,
): Promise<{ method: ReauthMethod; destination: string } | null> {
  const row = await getDb(env)
    .select({ email: schema.users.email, phone: schema.users.phone })
    .from(schema.users)
    .where(eq(schema.users.uid, uid))
    .get();
  if (!row) throw httpsError("not-found", "Account not found.");
  if (row.phone) return { method: "phone", destination: row.phone };
  if (row.email) return { method: "email", destination: row.email };
  return null;
}

/**
 * Send a challenge code to the identifier already on the account.
 *
 * Note the direction: this goes to the CURRENT identifier, never to a new one the
 * request supplied. That is what makes it a proof of ownership rather than a
 * formality — a caller who can choose the destination has proved nothing.
 */
export async function sendReauthChallenge(
  env: Env,
  uid: string,
  ip: string,
): Promise<ReauthChallenge> {
  const target = await reauthOptions(env, uid);
  if (!target) {
    // No identifier to challenge. Refusing here would strand the account with no
    // way to delete itself, so the caller decides — see `assertRecentAuthOrSelfService`.
    throw httpsError(
      "failed-precondition",
      "This account has no email address or phone number to send a code to. Please sign in again instead.",
    );
  }

  const configured =
    target.method === "phone" ? await smsConfigured(env) : await emailConfigured(env);
  if (!configured) {
    throw httpsError(
      "internal",
      "We can't send a code right now. Please sign out and sign in again to continue.",
    );
  }

  // Keyed on the uid AND the destination. The destination is this user's own
  // identifier so it cannot be aimed at a stranger, but a compromised session
  // could still be used to bury the real owner in codes.
  await rateLimit(env, `reauth:${uid}`, 10, 3600, { failClosed: true });
  await rateLimit(env, `reauth_ip:${ip}`, 20, 3600, { failClosed: true });
  await enforceSendCooldown(env, "reauth", uid, CHALLENGE_COOLDOWN_SEC);

  const otp = generateOtp();
  await setOtp(env, "reauth", uid, { otp, method: target.method, createdAt: now() });
  await markSent(env, "reauth", uid, CHALLENGE_COOLDOWN_SEC);

  const sent =
    target.method === "phone"
      ? await sendSms(
          env,
          target.destination,
          `${otp} is your TopHunt security code. It expires in 10 minutes. If you did not request it, someone may be trying to change your account — do not share it.`,
          otp,
        )
      : await sendEmail(env, { to: target.destination, ...securityCodeEmail(otp) });

  if (!sent) {
    // Same contract as the identifier-change sends: report the failure and leave
    // the user able to retry at once, rather than behind a cooldown protecting a
    // code that was never delivered.
    await Promise.all([
      deleteOtp(env, "reauth", uid),
      clearSendCooldown(env, "reauth", uid),
    ]);
    throw httpsError("internal", "We couldn't send the code right now. Please try again in a moment.");
  }

  return {
    method: target.method,
    sentTo: target.method === "phone" ? maskPhone(target.destination) : maskEmail(target.destination),
    cooldownSeconds: CHALLENGE_COOLDOWN_SEC,
  };
}

/** Verify a challenge code and issue the grant. */
export async function confirmReauthChallenge(
  env: Env,
  uid: string,
  code: unknown,
): Promise<{ verified: true; expiresInSeconds: number }> {
  // Fail-closed and strict: this is the gate itself, so a brute-force budget here
  // is a brute-force budget on every action behind it. `verifyOtp` additionally
  // burns the code after 5 wrong guesses.
  await rateLimit(env, `reauthverify:${uid}`, 15, 3600, { failClosed: true });
  await verifyOtp(env, "reauth", uid, code as string | undefined);
  await storeReauthGrant(env, uid);
  return { verified: true, expiresInSeconds: REAUTH_GRANT_TTL_SEC };
}

/**
 * The gate, but never a dead end.
 *
 * Used by account deletion. An account with no email and no phone cannot be
 * challenged, and refusing would leave it unable to delete itself — the exact
 * store-compliance hole the deletion work was done to close. In that one case the
 * fresh-session requirement stands alone: the user can still satisfy it by signing
 * in again, which is something they can always do.
 */
export async function assertRecentAuthForDeletion(env: Env, user: AuthUser): Promise<void> {
  if (hasFreshSession(user)) return;
  if (await hasReauthGrant(env, user.uid)) return;

  const target = await reauthOptions(env, user.uid).catch(() => null);
  if (!target) {
    throw httpsError(
      "failed-precondition",
      `${REAUTH_REQUIRED_CODE}: For your security, please sign out and sign in again before deleting your account.`,
    );
  }
  throw httpsError(
    "failed-precondition",
    `${REAUTH_REQUIRED_CODE}: For your security, please confirm it's you before deleting your account.`,
  );
}
