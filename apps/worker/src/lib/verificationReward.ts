/**
 * Registration verification reward.
 *
 *   signup                         → nothing. The signup bonus was removed; new users
 *                                    are rewarded only through the referral program
 *                                    (lib/referralProgram.ts). `registrationReward` is
 *                                    kept in the schema for history and is always 0.
 *   email AND mobile both verified → `completionReward`   (default 90) coins, once
 *
 * Everything here is server-authoritative:
 *  - amounts come from admin App Control (`appConfig.verificationReward`), and the
 *    completion amount is SNAPSHOTTED into the user's enrolment row at signup, so
 *    a later config change never re-prices a promise already shown to them;
 *  - "verified" means `users.email_verified` / `users.phone_verified`, which are
 *    written only by server-side proof (our OTP flows in lib/identifierChange.ts and
 *    phone sign-in, or Firebase's own record read server-to-server in
 *    `refreshVerificationFromFirebase`). No client-supplied flag is ever read;
 *  - the credit is ONE D1 batch whose every statement re-checks eligibility
 *    (enrolled, not yet completed, both flags set ON THE SAME email/phone the
 *    identifier hashes were computed from, account active, identifiers never
 *    rewarded on another account), with a deterministic ledger id. A retry, a
 *    duplicate event or a concurrent request therefore credits at most once.
 *
 * Only accounts enrolled at signup (migration 0054) are eligible; no existing
 * account is enrolled retroactively. See the migration header for why.
 */
import type { Env } from "../types";
import { getDb, schema } from "../db";
import { eq } from "drizzle-orm";
import { httpsError } from "./http";
import { getAppConfig } from "./settings";
import { lookupAuthUser } from "./firebaseAdmin";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_COINS = 1_000_000;

export interface VerificationRewardConfig {
  enabled: boolean;
  registrationReward: number;
  completionReward: number;
  maxTotalReward: number;
  requireEmail: boolean;
  requirePhone: boolean;
  initialReminderDays: number;
  repeatReminderDays: number;
  maxReminders: number;
  emailResendCooldownSec: number;
  smsResendCooldownSec: number;
}

export const VERIFICATION_REWARD_DEFAULTS: VerificationRewardConfig = {
  enabled: true,
  registrationReward: 0,
  completionReward: 90,
  maxTotalReward: 100,
  requireEmail: true,
  requirePhone: true,
  initialReminderDays: 3,
  repeatReminderDays: 7,
  maxReminders: 5,
  emailResendCooldownSec: 60,
  smsResendCooldownSec: 60,
};

/** Bounds for every numeric setting: [min, max]. Shared by parse and admin validation. */
const NUMERIC_BOUNDS: Record<string, [number, number]> = {
  registrationReward: [0, MAX_COINS],
  completionReward: [0, MAX_COINS],
  maxTotalReward: [0, MAX_COINS],
  initialReminderDays: [1, 365],
  repeatReminderDays: [1, 365],
  maxReminders: [0, 50],
  // Never below the OTP flow's built-in 60s: a config can slow resends, not speed them up.
  emailResendCooldownSec: [60, 3600],
  smsResendCooldownSec: [60, 3600],
};
const BOOLEAN_KEYS = ["enabled", "requireEmail", "requirePhone"] as const;

/** Stable ledger identifiers. The registration id is the historical signup_bonus id. */
export const registrationLedgerId = (uid: string) => `signup_bonus:${uid}`;
export const completionLedgerId = (uid: string) => `verification_bonus:${uid}`;
export const COMPLETION_LEDGER_TYPE = "verification_bonus";

/**
 * Read config with fail-safe parsing. Anything malformed falls back to its
 * default; an internally inconsistent config (rewards above the cap) is clamped
 * so the cap always holds — the admin endpoint rejects such configs up front.
 */
export function parseVerificationRewardConfig(raw: unknown): VerificationRewardConfig {
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: any = { ...VERIFICATION_REWARD_DEFAULTS };
  for (const key of BOOLEAN_KEYS) if (typeof src[key] === "boolean") out[key] = src[key];
  for (const [key, [min, max]] of Object.entries(NUMERIC_BOUNDS)) {
    const n = Number(src[key]);
    if (src[key] !== undefined && src[key] !== null && Number.isInteger(n) && n >= min && n <= max) out[key] = n;
  }
  // No signup bonus: the registration part of the reward is always 0.
  out.registrationReward = 0;
  if (out.registrationReward + out.completionReward > out.maxTotalReward) {
    out.completionReward = out.maxTotalReward - out.registrationReward;
  }
  return out as VerificationRewardConfig;
}

/** Admin-side validation of a `verificationReward` patch merged onto the current config. */
export function validateVerificationRewardConfig(merged: unknown): void {
  if (!merged || typeof merged !== "object" || Array.isArray(merged)) {
    throw httpsError("invalid-argument", "verificationReward must be an object.");
  }
  const src = merged as Record<string, unknown>;
  for (const key of Object.keys(src)) {
    if (!(key in VERIFICATION_REWARD_DEFAULTS)) {
      throw httpsError("invalid-argument", `verificationReward.${key} is not a known setting.`);
    }
  }
  for (const key of BOOLEAN_KEYS) {
    if (src[key] !== undefined && typeof src[key] !== "boolean") {
      throw httpsError("invalid-argument", `verificationReward.${key} must be true or false.`);
    }
  }
  for (const [key, [min, max]] of Object.entries(NUMERIC_BOUNDS)) {
    const v = src[key];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
      throw httpsError("invalid-argument", `verificationReward.${key} must be a whole number between ${min} and ${max}.`);
    }
  }
  const cfg = { ...VERIFICATION_REWARD_DEFAULTS, ...src } as VerificationRewardConfig;
  if (cfg.registrationReward + cfg.completionReward > cfg.maxTotalReward) {
    throw httpsError(
      "invalid-argument",
      `Registration reward (${cfg.registrationReward}) + completion reward (${cfg.completionReward}) exceeds the maximum combined reward (${cfg.maxTotalReward}).`,
    );
  }
  if (!cfg.requireEmail && !cfg.requirePhone && cfg.completionReward > 0) {
    throw httpsError("invalid-argument", "At least one of email or mobile verification must be required for a completion reward.");
  }
}

export async function getVerificationRewardConfig(env: Env): Promise<VerificationRewardConfig> {
  const cfg = await getAppConfig(env);
  return parseVerificationRewardConfig((cfg as any)?.verificationReward);
}

// ---------------------------------------------------------------------------
// Identifier canonicalisation (anti-farming)
// ---------------------------------------------------------------------------

/**
 * Canonical form used ONLY for the one-bonus-per-identifier check. Deliberately
 * more aggressive than storage normalisation, so trivial variants of one real
 * mailbox / number cannot each claim a bonus.
 */
export function canonicalIdentifier(kind: "email" | "phone", value: string): string {
  if (kind === "phone") {
    let digits = value.replace(/\D/g, "").replace(/^00/, "");
    // App default country is India (+91); a bare 10-digit number is that number.
    if (digits.length === 10) digits = `91${digits}`;
    return `phone:${digits}`;
  }
  const email = value.trim().toLowerCase();
  const [localRaw, domainRaw = ""] = email.split("@");
  let local = localRaw.split("+")[0];
  const domain = domainRaw === "googlemail.com" ? "gmail.com" : domainRaw;
  if (domain === "gmail.com") local = local.replace(/\./g, "");
  return `email:${local}@${domain}`;
}

export async function identifierHash(kind: "email" | "phone", value: string): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalIdentifier(kind, value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Enrolment (called from signup)
// ---------------------------------------------------------------------------

/**
 * What a brand-new account receives at signup, and the enrolment row to write in
 * the SAME batch as the profile insert. `legacySignupBonus` is the pre-existing
 * `rewardSettings.signupBonus`, used unchanged when this feature is disabled.
 */
export function signupGrant(
  cfg: VerificationRewardConfig,
  legacySignupBonus: number,
): { amount: number; enrol: boolean; completionReward: number } {
  // There is NO signup bonus any more: joining earns coins only through a referral
  // (lib/referralProgram.ts). The verification reward pays only on completing
  // email + mobile verification. `legacySignupBonus` is ignored.
  void legacySignupBonus;
  if (!cfg.enabled) return { amount: 0, enrol: false, completionReward: 0 };
  return { amount: 0, enrol: true, completionReward: cfg.completionReward };
}

// ---------------------------------------------------------------------------
// Completion credit
// ---------------------------------------------------------------------------

export type CompletionReason =
  | "credited"
  | "already_completed"
  | "not_enrolled"
  | "disabled"
  | "email_unverified"
  | "phone_unverified"
  | "account_restricted"
  | "identifier_already_rewarded";

export interface CompletionResult {
  credited: boolean;
  reason: CompletionReason;
  coins: number;
}

/**
 * Credit the completion bonus if — and only if — the account is eligible right
 * now. Safe to call from anywhere, any number of times, concurrently.
 */
export async function tryCreditVerificationReward(env: Env, uid: string): Promise<CompletionResult> {
  const db = getDb(env);
  const cfg = await getVerificationRewardConfig(env);
  const enrolment = await db.select().from(schema.verificationRewards).where(eq(schema.verificationRewards.uid, uid)).get();
  if (!enrolment) return { credited: false, reason: "not_enrolled", coins: 0 };
  if (enrolment.completedAt) return { credited: false, reason: "already_completed", coins: 0 };
  // Disabling the feature PAUSES completion credits (e.g. during a fraud
  // incident); the snapshot promise is kept and honoured once re-enabled.
  if (!cfg.enabled) return { credited: false, reason: "disabled", coins: 0 };

  const user = await db
    .select({
      email: schema.users.email,
      phone: schema.users.phone,
      emailVerified: schema.users.emailVerified,
      phoneVerified: schema.users.phoneVerified,
      status: schema.users.status,
      isBlocked: schema.users.isBlocked,
    })
    .from(schema.users)
    .where(eq(schema.users.uid, uid))
    .get();
  if (!user) return { credited: false, reason: "not_enrolled", coins: 0 };
  if ((user.status ?? "active") !== "active" || user.isBlocked) {
    return { credited: false, reason: "account_restricted", coins: 0 };
  }
  if (cfg.requireEmail && !(user.emailVerified && user.email)) return { credited: false, reason: "email_unverified", coins: 0 };
  if (cfg.requirePhone && !(user.phoneVerified && user.phone)) return { credited: false, reason: "phone_unverified", coins: 0 };

  const amount = Math.max(0, Math.floor(Number(enrolment.completionReward) || 0));
  const ts = Date.now();
  const ledgerId = completionLedgerId(uid);

  // Identifier hashes for the one-bonus-per-identifier rule, computed from the
  // values just read; the batch re-checks that the row still holds exactly these.
  const hashes: Array<{ hash: string; kind: "email" | "phone" }> = [];
  if (cfg.requireEmail) hashes.push({ hash: await identifierHash("email", user.email!), kind: "email" });
  if (cfg.requirePhone) hashes.push({ hash: await identifierHash("phone", user.phone!), kind: "phone" });

  const userConds: string[] = ["uid = ?", "COALESCE(status, 'active') = 'active'", "COALESCE(is_blocked, 0) = 0"];
  const userBinds: unknown[] = [uid];
  if (cfg.requireEmail) {
    userConds.push("email_verified = 1", "email = ?");
    userBinds.push(user.email);
  }
  if (cfg.requirePhone) {
    userConds.push("phone_verified = 1", "phone = ?");
    userBinds.push(user.phone);
  }
  const hashPlaceholders = hashes.map(() => "?").join(", ");
  const gate =
    `EXISTS (SELECT 1 FROM users WHERE ${userConds.join(" AND ")})` +
    ` AND EXISTS (SELECT 1 FROM verification_rewards WHERE uid = ? AND completed_at IS NULL)` +
    (hashes.length
      ? ` AND NOT EXISTS (SELECT 1 FROM verification_reward_claims WHERE identifier_hash IN (${hashPlaceholders}) AND uid != ?)`
      : "");
  const gateBinds = [...userBinds, uid, ...(hashes.length ? [...hashes.map((h) => h.hash), uid] : [])];
  const credited = `EXISTS (SELECT 1 FROM coin_transactions WHERE id = ?)`;

  const statements: D1PreparedStatement[] = [];
  if (amount > 0) {
    statements.push(
      // Balance first, gated on the ledger row being absent; the ledger insert
      // shares the gate, so both apply or neither does.
      env.DB.prepare(
        `UPDATE users SET dpcoin = dpcoin + ?, updated_at = ?
          WHERE uid = ? AND ${gate} AND NOT ${credited}`,
      ).bind(amount, ts, uid, ...gateBinds, ledgerId),
      env.DB.prepare(
        `INSERT OR IGNORE INTO coin_transactions (id, uid, amount, type, description, created_at)
         SELECT ?, ?, ?, '${COMPLETION_LEDGER_TYPE}', ?, ?
          WHERE ${gate}`,
      ).bind(ledgerId, uid, amount, "Bonus for verifying your email and mobile number", ts, ...gateBinds),
    );
  }
  // From here on, "done" is: ledger row present (or nothing to pay) AND still open.
  const done = amount > 0 ? credited : gate;
  const doneBinds = amount > 0 ? [ledgerId] : gateBinds;
  for (const h of hashes) {
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO verification_reward_claims (identifier_hash, kind, uid, created_at)
         SELECT ?, ?, ?, ?
          WHERE ${done} AND EXISTS (SELECT 1 FROM verification_rewards WHERE uid = ? AND completed_at IS NULL)`,
      ).bind(h.hash, h.kind, uid, ts, ...doneBinds, uid),
    );
  }
  statements.push(
    env.DB.prepare(
      `UPDATE verification_rewards
          SET completed_at = ?, completion_ledger_id = ?, updated_at = ?
        WHERE uid = ? AND completed_at IS NULL AND ${done}`,
    ).bind(ts, amount > 0 ? ledgerId : null, ts, uid, ...doneBinds),
  );

  const results = await env.DB.batch(statements);
  const completedNow = Number(results[results.length - 1]?.meta?.changes || 0) > 0;
  const paid = amount > 0 ? Number(results[0]?.meta?.changes || 0) > 0 : false;

  if (completedNow) {
    console.log(JSON.stringify({ event: "verification_reward.completed", uid, coins: paid ? amount : 0 }));
    return { credited: paid, reason: "credited", coins: paid ? amount : 0 };
  }

  // Nothing applied. Work out why, without guessing.
  const after = await db.select({ completedAt: schema.verificationRewards.completedAt }).from(schema.verificationRewards)
    .where(eq(schema.verificationRewards.uid, uid)).get();
  if (after?.completedAt) {
    console.log(JSON.stringify({ event: "verification_reward.duplicate_attempt", uid }));
    return { credited: false, reason: "already_completed", coins: 0 };
  }
  if (hashes.length) {
    const taken = await env.DB.prepare(
      `SELECT 1 AS x FROM verification_reward_claims WHERE identifier_hash IN (${hashPlaceholders}) AND uid != ? LIMIT 1`,
    ).bind(...hashes.map((h) => h.hash), uid).first();
    if (taken) {
      console.warn(JSON.stringify({ event: "verification_reward.identifier_reused", uid }));
      return { credited: false, reason: "identifier_already_rewarded", coins: 0 };
    }
  }
  // The row changed between the read and the batch (e.g. an identifier changed).
  return { credited: false, reason: cfg.requireEmail ? "email_unverified" : "phone_unverified", coins: 0 };
}

// ---------------------------------------------------------------------------
// Trusted refresh from Firebase
// ---------------------------------------------------------------------------

/**
 * Promote D1 verification flags from Firebase's OWN record, fetched
 * server-to-server with the service account (never from the client, never from a
 * possibly stale ID-token claim).
 *
 *  - email: Firebase `emailVerified` is set by its email-link flow (the link the
 *    app already sends at signup) or by a provider that verifies email (Google).
 *    Counted only when Firebase's address equals the address on the D1 profile.
 *  - phone: Firebase `phoneNumber` is set only after an SMS proof — Firebase phone
 *    auth, our OTP sign-in (`createAuthUser`), or the OTP change flow. Counted only
 *    when it is the same number as the D1 profile.
 *
 * Each UPDATE re-checks the D1 value it matched against, so a concurrent
 * identifier change cannot be marked verified by stale evidence.
 */
export async function refreshVerificationFromFirebase(
  env: Env,
  uid: string,
): Promise<{ emailVerified: boolean; phoneVerified: boolean; checked: boolean }> {
  const db = getDb(env);
  const user = await db
    .select({ email: schema.users.email, phone: schema.users.phone, emailVerified: schema.users.emailVerified, phoneVerified: schema.users.phoneVerified })
    .from(schema.users)
    .where(eq(schema.users.uid, uid))
    .get();
  if (!user) throw httpsError("not-found", "User not found.");
  let emailVerified = !!user.emailVerified;
  let phoneVerified = !!user.phoneVerified;
  if (emailVerified && phoneVerified) return { emailVerified, phoneVerified, checked: false };

  const fb = await lookupAuthUser(env, uid).catch((e) => {
    console.error("[verificationReward] Firebase lookup failed", uid, e?.message || e);
    return null;
  });
  if (!fb) return { emailVerified, phoneVerified, checked: false };
  const ts = Date.now();

  if (!emailVerified && user.email && fb.emailVerified && fb.email && fb.email.trim().toLowerCase() === user.email.toLowerCase()) {
    const r = await env.DB.prepare(
      `UPDATE users SET email_verified = 1, email_verified_at = ?, updated_at = ? WHERE uid = ? AND email = ? AND email_verified = 0`,
    ).bind(ts, ts, uid, user.email).run();
    emailVerified = emailVerified || Number(r.meta?.changes || 0) > 0;
  }
  if (
    !phoneVerified &&
    user.phone &&
    fb.phoneNumber &&
    canonicalIdentifier("phone", fb.phoneNumber) === canonicalIdentifier("phone", user.phone)
  ) {
    const r = await env.DB.prepare(
      `UPDATE users SET phone_verified = 1, phone_verified_at = ?, updated_at = ? WHERE uid = ? AND phone = ? AND phone_verified = 0`,
    ).bind(ts, ts, uid, user.phone).run();
    phoneVerified = phoneVerified || Number(r.meta?.changes || 0) > 0;
  }
  return { emailVerified, phoneVerified, checked: true };
}

// ---------------------------------------------------------------------------
// Status + reminders
// ---------------------------------------------------------------------------

function maskEmail(email: string | null): string | null {
  if (!email) return null;
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  return `${local.slice(0, 2)}${"*".repeat(Math.max(3, local.length - 2))}@${domain}`;
}
function maskPhone(phone: string | null): string | null {
  if (!phone) return null;
  return phone.length <= 7 ? "****" : `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

/** When the next in-app prompt may appear, or null when none is due ever again. */
export function nextPromptAt(
  row: { promptCount: number; lastPromptAt: number | null; completedAt: number | null } | null,
  cfg: VerificationRewardConfig,
): number | null {
  if (!row || row.completedAt || !cfg.enabled) return null;
  const count = Number(row.promptCount) || 0;
  if (count >= cfg.maxReminders) return null;
  if (count === 0 || !row.lastPromptAt) return 0; // first prompt: right after signup
  const gapDays = count === 1 ? cfg.initialReminderDays : cfg.repeatReminderDays;
  return row.lastPromptAt + gapDays * DAY_MS;
}

export async function getVerificationStatus(env: Env, uid: string, now = Date.now()) {
  const db = getDb(env);
  const [cfg, user, row] = await Promise.all([
    getVerificationRewardConfig(env),
    db
      .select({ email: schema.users.email, phone: schema.users.phone, emailVerified: schema.users.emailVerified, phoneVerified: schema.users.phoneVerified, status: schema.users.status })
      .from(schema.users)
      .where(eq(schema.users.uid, uid))
      .get(),
    db.select().from(schema.verificationRewards).where(eq(schema.verificationRewards.uid, uid)).get(),
  ]);
  if (!user) throw httpsError("not-found", "User not found.");
  const emailVerified = !!user.emailVerified && !!user.email;
  const phoneVerified = !!user.phoneVerified && !!user.phone;
  const remaining: Array<"email" | "phone"> = [];
  if (cfg.requireEmail && !emailVerified) remaining.push("email");
  if (cfg.requirePhone && !phoneVerified) remaining.push("phone");

  const registrationReward = row ? Number(row.registrationReward) || 0 : 0;
  const completionReward = row ? Number(row.completionReward) || 0 : 0;
  const completed = !!row?.completedAt;
  const due = (user.status ?? "active") === "active" ? nextPromptAt(row ?? null, cfg) : null;

  return {
    enrolled: !!row,
    featureEnabled: cfg.enabled,
    email: maskEmail(user.email),
    phone: maskPhone(user.phone),
    hasEmail: !!user.email,
    hasPhone: !!user.phone,
    emailVerified,
    phoneVerified,
    requireEmail: cfg.requireEmail,
    requirePhone: cfg.requirePhone,
    remaining,
    registrationReward,
    completionReward,
    totalReward: registrationReward + completionReward,
    earnedReward: registrationReward + (completed ? completionReward : 0),
    completed,
    completedAt: row?.completedAt ?? null,
    promptDue: due !== null && now >= due,
    nextPromptAt: due,
    emailResendCooldownSec: cfg.emailResendCooldownSec,
    smsResendCooldownSec: cfg.smsResendCooldownSec,
  };
}

/** De-dupe window: two devices showing the prompt at once count as one showing. */
const PROMPT_DEDUPE_MS = 10 * 60 * 1000;

/**
 * Record that the prompt was shown. This (not the dismiss button) is what drives
 * the schedule, so closing the app without tapping anything does not re-show it
 * on every launch. Conditional on the last showing being older than the de-dupe
 * window, so several devices cannot burn through the reminder budget at once.
 */
export async function recordPromptShown(env: Env, uid: string, now = Date.now()): Promise<boolean> {
  const r = await env.DB.prepare(
    `UPDATE verification_rewards
        SET prompt_count = prompt_count + 1, last_prompt_at = ?, updated_at = ?
      WHERE uid = ? AND completed_at IS NULL
        AND (last_prompt_at IS NULL OR last_prompt_at <= ?)`,
  ).bind(now, now, uid, now - PROMPT_DEDUPE_MS).run();
  return Number(r.meta?.changes || 0) > 0;
}

/** Admin-visible counters. Bounded aggregate queries over indexed tables. */
export async function verificationRewardStats(env: Env) {
  const row = await env.DB.prepare(
    `SELECT
       COUNT(*) AS enrolled,
       SUM(CASE WHEN vr.completed_at IS NOT NULL THEN 1 ELSE 0 END) AS completed,
       SUM(CASE WHEN vr.completed_at IS NULL AND u.email_verified = 1 AND u.phone_verified = 0 THEN 1 ELSE 0 END) AS emailOnly,
       SUM(CASE WHEN vr.completed_at IS NULL AND u.email_verified = 0 AND u.phone_verified = 1 THEN 1 ELSE 0 END) AS phoneOnly,
       SUM(CASE WHEN vr.completed_at IS NULL AND COALESCE(u.email_verified,0) = 0 AND COALESCE(u.phone_verified,0) = 0 THEN 1 ELSE 0 END) AS neither,
       SUM(vr.registration_reward) AS registrationCoins
     FROM verification_rewards vr LEFT JOIN users u ON u.uid = vr.uid`,
  ).first<Record<string, number | null>>();
  const coins = await env.DB.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS c, COUNT(*) AS n FROM coin_transactions WHERE type = '${COMPLETION_LEDGER_TYPE}'`,
  ).first<{ c: number; n: number }>();
  return {
    enrolled: Number(row?.enrolled ?? 0),
    completed: Number(row?.completed ?? 0),
    pendingEmailOnly: Number(row?.emailOnly ?? 0),
    pendingPhoneOnly: Number(row?.phoneOnly ?? 0),
    pendingNeither: Number(row?.neither ?? 0),
    registrationCoinsCredited: Number(row?.registrationCoins ?? 0),
    completionCoinsCredited: Number(coins?.c ?? 0),
    completionCredits: Number(coins?.n ?? 0),
  };
}
