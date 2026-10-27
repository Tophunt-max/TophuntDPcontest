/**
 * Referral program — modelled on how real-money apps run theirs
 * (Dream11, MPL, Zupee, PhonePe, CRED):
 *
 *   1. Every account has a code (`users.referral_code`) and a share link
 *      `https://tophunt.in/invite/<CODE>`.
 *   2. A new user applies a code at signup (or within `applyWindowDays` of
 *      joining). That creates a PENDING referral — nothing is paid yet.
 *   3. The invited user must do something real within `qualifyWindowDays`: the
 *      admin-chosen `qualifyAction` — signup, verified (email AND mobile), first
 *      contest entry, or first coin purchase. Then it QUALIFIES.
 *   4. Qualified → REWARDED: the invited user gets `refereeReward`, the referrer
 *      `referrerReward` (two-sided), both idempotent ledger credits, both notified.
 *      With `requireReview` on, a qualified referral waits in REVIEW for an admin.
 *   5. Milestone bonuses for the referrer at N successful referrals (tiers).
 *   6. Unqualified referrals EXPIRE (cron).
 *
 * Fraud controls (each a hard reject with a recorded reason):
 *   - self-referral; a code applied to an account older than the apply window;
 *   - the same device as the referrer, or a device that already earned a referral;
 *   - the referrer blocked / deleted;
 *   - a referrer cap: lifetime and per-day rewarded referrals (the invited user
 *     is still paid; the referrer's share is recorded as 0 with the reason);
 *   - status transitions are compare-and-swap, credits are claim-keyed — a retry,
 *     a double hook or two concurrent qualifiers can never pay twice.
 *
 * There is no signup bonus: the only coins for joining come through a referral.
 */
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Env } from "../types";
import { getDb, schema } from "../db";
import { httpsError } from "./http";
import { adjustUserWallet, WalletReplay } from "./money";
import { createNotification } from "./notify";
import { newId, now } from "./ids";
import { getAppConfig } from "./settings";
import { rewardLocked } from "./rewardLocking";

export const QUALIFY_ACTIONS = ["signup", "verified", "first_contest", "first_purchase"] as const;
export type QualifyAction = (typeof QUALIFY_ACTIONS)[number];
export type ReferralEvent = "signup" | "verified" | "contest" | "purchase";
/** `reversed`: paid, then clawed back by an admin (reverseReferral). */
export const REFERRAL_STATUSES = ["pending", "review", "rewarded", "rejected", "expired", "reversed"] as const;

/** Hold for review: this many referrals of ONE referrer from one IP in 24h. */
export const REFERRAL_HOLD_SAME_IP = 2;
/** Hold for review: this many referrals (any referrer) from one IP in 24h. */
export const REFERRAL_HOLD_IP_SHARED = 4;
/** Hold for review: this many codes applied for one referrer within an hour. */
export const REFERRAL_HOLD_VELOCITY = 5;
export type ReferralStatus = (typeof REFERRAL_STATUSES)[number];

export interface ReferralMilestone {
  /** Successful (rewarded) referrals needed. */
  count: number;
  /** Extra coins for the referrer on reaching it. */
  bonus: number;
}

export interface ReferralProgramConfig {
  enabled: boolean;
  referrerReward: number;
  refereeReward: number;
  qualifyAction: QualifyAction;
  /** Days after joining in which a code may still be applied. */
  applyWindowDays: number;
  /** Days after applying in which the invited user must qualify. */
  qualifyWindowDays: number;
  /** Lifetime rewarded referrals per referrer (0 = unlimited). */
  maxRewardedPerReferrer: number;
  /** Rewarded referrals per referrer per rolling 24h (0 = unlimited). */
  maxRewardedPerReferrerPerDay: number;
  /** Hold qualified referrals for an admin before paying. */
  requireReview: boolean;
  milestones: ReferralMilestone[];
  /**
   * Referral coins (inviter + friend) paid per calendar month, UTC (0 = no
   * limit). Once reached, qualified referrals wait in review.
   */
  maxCoinsPerMonth: number;
  /** first_purchase only: the purchase must be at least this many ₹ (0 = any). */
  minPurchaseInr: number;
}

export const REFERRAL_DEFAULTS: ReferralProgramConfig = {
  enabled: true,
  referrerReward: 50,
  refereeReward: 50,
  qualifyAction: "first_contest",
  applyWindowDays: 7,
  qualifyWindowDays: 30,
  maxRewardedPerReferrer: 0,
  maxRewardedPerReferrerPerDay: 20,
  requireReview: false,
  milestones: [],
  maxCoinsPerMonth: 0,
  minPurchaseInr: 0,
};

const MAX_COINS = 100_000;
const DAY = 24 * 60 * 60 * 1000;
const EVENT_FOR_ACTION: Record<QualifyAction, ReferralEvent> = {
  signup: "signup",
  verified: "verified",
  first_contest: "contest",
  first_purchase: "purchase",
};

const int = (v: unknown, min: number, max: number): number | null => {
  const n = Number(v);
  return v !== undefined && v !== null && v !== "" && Number.isInteger(n) && n >= min && n <= max ? n : null;
};

/**
 * Effective config from `appConfig`. Never throws. Before the admin saves a
 * program, the legacy `rewardSettings.referralBonus` seeds both rewards, so the
 * existing amount carries over.
 */
export function parseReferralConfig(appConfig: any): ReferralProgramConfig {
  const src = (appConfig?.referralProgram && typeof appConfig.referralProgram === "object" ? appConfig.referralProgram : {}) as any;
  const legacy = int(appConfig?.rewardSettings?.referralBonus, 0, MAX_COINS);
  const out: ReferralProgramConfig = {
    ...REFERRAL_DEFAULTS,
    ...(legacy !== null ? { referrerReward: legacy, refereeReward: legacy } : {}),
    milestones: [],
  };
  if (typeof src.enabled === "boolean") out.enabled = src.enabled;
  if (typeof src.requireReview === "boolean") out.requireReview = src.requireReview;
  if ((QUALIFY_ACTIONS as readonly string[]).includes(src.qualifyAction)) out.qualifyAction = src.qualifyAction;
  const bounds: [keyof ReferralProgramConfig, number, number][] = [
    ["referrerReward", 0, MAX_COINS],
    ["refereeReward", 0, MAX_COINS],
    ["applyWindowDays", 0, 90],
    ["qualifyWindowDays", 1, 365],
    ["maxRewardedPerReferrer", 0, 100_000],
    ["maxRewardedPerReferrerPerDay", 0, 10_000],
    ["maxCoinsPerMonth", 0, 100_000_000],
    ["minPurchaseInr", 0, 1_000_000],
  ];
  for (const [k, lo, hi] of bounds) {
    const n = int(src[k], lo, hi);
    if (n !== null) (out as any)[k] = n;
  }
  if (Array.isArray(src.milestones)) {
    out.milestones = src.milestones
      .map((m: any) => ({ count: int(m?.count, 1, 100_000), bonus: int(m?.bonus, 1, MAX_COINS) }))
      .filter((m: any) => m.count !== null && m.bonus !== null)
      .sort((a: any, b: any) => a.count - b.count) as ReferralMilestone[];
  }
  return out;
}

/** Admin-side validation of a `referralProgram` patch (in place). Throws on anything invalid. */
export function validateReferralPatch(p: any): void {
  const bad = (m: string): never => {
    throw httpsError("invalid-argument", m);
  };
  if (!p || typeof p !== "object") bad("referralProgram must be an object.");
  for (const k of ["enabled", "requireReview"]) if (p[k] !== undefined && typeof p[k] !== "boolean") bad(`referralProgram.${k} must be true or false.`);
  if (p.qualifyAction !== undefined && !(QUALIFY_ACTIONS as readonly string[]).includes(p.qualifyAction)) {
    bad(`Qualifying action must be one of: ${QUALIFY_ACTIONS.join(", ")}.`);
  }
  const whole = (k: string, lo: number, hi: number, label: string) => {
    if (p[k] === undefined) return;
    if (int(p[k], lo, hi) === null) bad(`${label} must be a whole number from ${lo} to ${hi}.`);
    p[k] = Number(p[k]);
  };
  whole("referrerReward", 0, MAX_COINS, "Referrer reward (coins)");
  whole("refereeReward", 0, MAX_COINS, "Invited-friend reward (coins)");
  whole("applyWindowDays", 0, 90, "Code apply window (days)");
  whole("qualifyWindowDays", 1, 365, "Qualify window (days)");
  whole("maxRewardedPerReferrer", 0, 100_000, "Lifetime referral cap");
  whole("maxRewardedPerReferrerPerDay", 0, 10_000, "Daily referral cap");
  whole("maxCoinsPerMonth", 0, 100_000_000, "Monthly referral budget (coins)");
  whole("minPurchaseInr", 0, 1_000_000, "Minimum first purchase (₹)");
  if (p.milestones !== undefined) {
    if (!Array.isArray(p.milestones) || p.milestones.length > 20) bad("Milestones: a list of at most 20 tiers.");
    const seen = new Set<number>();
    p.milestones = p.milestones.map((m: any, i: number) => {
      const count = int(m?.count, 1, 100_000);
      const bonus = int(m?.bonus, 1, MAX_COINS);
      if (count === null || bonus === null) bad(`Milestone ${i + 1}: referrals (1–100000) and bonus coins (1–${MAX_COINS}) are required.`);
      if (seen.has(count!)) bad(`Milestone ${i + 1}: two tiers at ${count} referrals.`);
      seen.add(count!);
      return { count, bonus };
    });
    p.milestones.sort((a: any, b: any) => a.count - b.count);
  }
}

/**
 * What the app may show before sign-in (public app config). `rewardUnit` says
 * how referral rewards are credited: "Diamond" (play-only) or "DP coin"
 * (App Control → reward locking), so the app never hardcodes it.
 */
export function publicReferralConfig(cfg: ReferralProgramConfig, appConfig?: any) {
  return {
    enabled: cfg.enabled,
    referrerReward: cfg.referrerReward,
    refereeReward: cfg.refereeReward,
    qualifyAction: cfg.qualifyAction,
    applyWindowDays: cfg.applyWindowDays,
    qualifyWindowDays: cfg.qualifyWindowDays,
    milestones: cfg.milestones,
    minPurchaseInr: cfg.minPurchaseInr,
    rewardUnit: rewardLocked(appConfig, "referral") ? "Diamond" : "DP coin",
  };
}

// ---------------------------------------------------------------------------
// Codes
// ---------------------------------------------------------------------------

/** A short, URL-safe code (crypto RNG, so codes are unguessable). */
export function makeReferralCode(): string {
  // Rejection sampling: only bytes below 252 (= 7 × 36) are used, so every one
  // of the 36 characters is equally likely (a plain `% 36` would be biased).
  let s = "";
  while (s.length < 6) {
    for (const b of crypto.getRandomValues(new Uint8Array(12))) {
      if (b >= 252) continue;
      s += (b % 36).toString(36);
      if (s.length === 6) break;
    }
  }
  return "TH" + s.toUpperCase();
}

export function normalizeCode(raw: unknown): string {
  return String(raw ?? "").trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 32);
}

/** Give this user a code if they lack one (retries on the rare UNIQUE collision). */
export async function ensureReferralCode(env: Env, uid: string): Promise<string | null> {
  const db = getDb(env);
  for (let attempt = 0; attempt < 5; attempt++) {
    const row = await db.select({ code: schema.users.referralCode }).from(schema.users).where(eq(schema.users.uid, uid)).get();
    if (!row) return null;
    if (row.code) return row.code;
    try {
      await db
        .update(schema.users)
        .set({ referralCode: makeReferralCode() })
        .where(and(eq(schema.users.uid, uid), isNull(schema.users.referralCode)));
    } catch (err) {
      if (attempt === 4 || !/unique/i.test(String((err as Error)?.message))) throw err;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Apply a code
// ---------------------------------------------------------------------------

export type ApplyResult =
  | { status: "applied"; referralId: string; referralStatus: ReferralStatus; qualifyAction: QualifyAction }
  | { status: "already_referred" };

/**
 * Attach `uid` (the invited user) to the owner of `code`. Validates everything a
 * farmer would try and refuses with a message the user can understand. Creates
 * a PENDING referral; with `qualifyAction = signup` it qualifies at once.
 */
export async function applyReferralCode(
  env: Env,
  uid: string,
  rawCode: unknown,
  opts: { deviceId?: string | null; ip?: string | null; nowMs?: number } = {},
): Promise<ApplyResult> {
  const ts = opts.nowMs ?? now();
  const db = getDb(env);
  const cfgRow = await db.select({ data: schema.settings.data }).from(schema.settings).where(eq(schema.settings.id, "appConfig")).get();
  const cfg = parseReferralConfig(cfgRow?.data);
  if (!cfg.enabled) throw httpsError("failed-precondition", "Referral program abhi band hai.");
  const code = normalizeCode(rawCode);
  if (code.length < 4) throw httpsError("invalid-argument", "Referral code galat hai.");

  const me = await db
    .select({ uid: schema.users.uid, createdAt: schema.users.createdAt, referredBy: schema.users.referredBy, referralCode: schema.users.referralCode })
    .from(schema.users)
    .where(eq(schema.users.uid, uid))
    .get();
  if (!me) throw httpsError("failed-precondition", "Pehle apna profile poora karo.");
  if (me.referredBy) return { status: "already_referred" };
  const existing = await db.select({ id: schema.referrals.id }).from(schema.referrals).where(eq(schema.referrals.referredUid, uid)).get();
  if (existing) return { status: "already_referred" };
  if (cfg.applyWindowDays === 0 ? ts - Number(me.createdAt) > DAY : ts - Number(me.createdAt) > cfg.applyWindowDays * DAY) {
    throw httpsError("failed-precondition", `Referral code sirf join karne ke ${Math.max(1, cfg.applyWindowDays)} din ke andar lagta hai.`);
  }
  if (me.referralCode && me.referralCode.toUpperCase() === code) throw httpsError("invalid-argument", "Apna khud ka code nahi laga sakte.");

  const referrer = await db
    .select({ uid: schema.users.uid, status: schema.users.status, isBlocked: schema.users.isBlocked, deviceId: schema.users.deviceId, signupCompleted: schema.users.signupCompleted })
    .from(schema.users)
    .where(sql`upper(${schema.users.referralCode}) = ${code}`)
    .get();
  if (!referrer || !referrer.signupCompleted || referrer.isBlocked || (referrer.status && referrer.status !== "active")) {
    throw httpsError("not-found", "Ye referral code valid nahi hai.");
  }
  if (referrer.uid === uid) throw httpsError("invalid-argument", "Apna khud ka code nahi laga sakte.");

  const deviceId = opts.deviceId ? String(opts.deviceId).slice(0, 128) : null;
  if (deviceId) {
    // Remember this device on the account (fraud checks only).
    await db.update(schema.users).set({ deviceId }).where(eq(schema.users.uid, uid));
  }

  // Device checks decide pending vs rejected; the row is written either way, so
  // an admin can see the attempt.
  let rejectReason: string | null = null;
  if (deviceId && referrer.deviceId && referrer.deviceId === deviceId) rejectReason = "same_device_as_referrer";
  if (!rejectReason && deviceId) {
    const reused = await db
      .select({ id: schema.referrals.id })
      .from(schema.referrals)
      .where(and(eq(schema.referrals.deviceId, deviceId), inArray(schema.referrals.status, ["pending", "review", "rewarded", "reversed"])))
      .get();
    if (reused) rejectReason = "device_already_used";
  }

  // Softer signals than the hard rejects above: the referral is accepted but
  // HELD for admin review when it is paid (see qualifyReferral), even if the
  // program does not require review. A real friend is unaffected; a farm of
  // accounts behind one connection, or a sudden burst on one code, waits for
  // a person.
  const ip = opts.ip ? String(opts.ip).slice(0, 64) : null;
  let holdReason: string | null = null;
  if (!rejectReason) {
    const day = ts - 24 * 60 * 60 * 1000;
    const hour = ts - 60 * 60 * 1000;
    const signals = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM referrals WHERE ip = ? AND referrer_uid = ? AND created_at >= ?) AS same_ip_same_referrer,
         (SELECT COUNT(*) FROM referrals WHERE ip = ? AND created_at >= ?) AS same_ip_any,
         (SELECT COUNT(*) FROM referrals WHERE referrer_uid = ? AND created_at >= ?) AS referrer_last_hour`,
    ).bind(ip, referrer.uid, day, ip, day, referrer.uid, hour).first<any>().catch(() => null);
    if (ip && Number(signals?.same_ip_same_referrer) >= REFERRAL_HOLD_SAME_IP) holdReason = "same_ip_burst";
    else if (ip && Number(signals?.same_ip_any) >= REFERRAL_HOLD_IP_SHARED) holdReason = "ip_shared";
    else if (Number(signals?.referrer_last_hour) >= REFERRAL_HOLD_VELOCITY) holdReason = "referrer_velocity";
    // The app always sends a device id. Without one, none of the device checks
    // above ran, so a person decides.
    else if (!deviceId) holdReason = "no_device";
  }
  const id = newId();
  const status: ReferralStatus = rejectReason ? "rejected" : "pending";
  const res = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO referrals
         (id, referrer_uid, referred_uid, bonus, created_at, status, code, qualify_action, expires_at, reject_reason, device_id, updated_at, ip, hold_reason)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, referrer.uid, uid, ts, status, code, cfg.qualifyAction, ts + cfg.qualifyWindowDays * DAY, rejectReason, deviceId, ts, ip, holdReason),
    // Attribution is permanent and first-come: referredBy is set once.
    env.DB.prepare(`UPDATE users SET referred_by = ?, updated_at = ? WHERE uid = ? AND referred_by IS NULL AND EXISTS (SELECT 1 FROM referrals WHERE id = ?)`).bind(
      referrer.uid,
      ts,
      uid,
      id,
    ),
  ]);
  if (Number(res[0]?.meta?.changes || 0) === 0) return { status: "already_referred" };
  if (rejectReason) {
    throw httpsError("failed-precondition", "Ye referral is device par lag nahi sakta.");
  }
  if (cfg.qualifyAction === "signup") await qualifyReferral(env, uid, "signup", { nowMs: ts });
  const after = await db.select({ status: schema.referrals.status }).from(schema.referrals).where(eq(schema.referrals.id, id)).get();
  return { status: "applied", referralId: id, referralStatus: (after?.status as ReferralStatus) ?? "pending", qualifyAction: cfg.qualifyAction };
}

// ---------------------------------------------------------------------------
// Qualify + reward
// ---------------------------------------------------------------------------

/**
 * Called by the qualifying actions (signup, verification, contest entry, coin
 * purchase). Cheap when nothing applies: one indexed lookup by `referred_uid`.
 * Never throws — a referral problem must not fail the action that triggered it.
 *
 * `amountInr` is the purchase amount for the "purchase" event; with
 * `minPurchaseInr` set, a smaller purchase does not qualify (a later, larger
 * one still can).
 */
export async function qualifyReferral(
  env: Env,
  uid: string,
  event: ReferralEvent,
  opts: { nowMs?: number; amountInr?: number } = {},
): Promise<void> {
  try {
    const ts = opts.nowMs ?? now();
    const db = getDb(env);
    const row = await db.select().from(schema.referrals).where(eq(schema.referrals.referredUid, uid)).get();
    if (!row || row.status !== "pending") return;
    const action = (row.qualifyAction as QualifyAction) || "first_contest";
    if (EVENT_FOR_ACTION[action] !== event) return;
    if (row.expiresAt && ts > Number(row.expiresAt)) {
      await db.update(schema.referrals).set({ status: "expired", updatedAt: ts }).where(and(eq(schema.referrals.id, row.id), eq(schema.referrals.status, "pending")));
      return;
    }
    if (event === "verified") {
      const u = await db.select({ e: schema.users.emailVerified, p: schema.users.phoneVerified }).from(schema.users).where(eq(schema.users.uid, uid)).get();
      if (!u?.e || !u?.p) return;
    }
    const cfgRow = await db.select({ data: schema.settings.data }).from(schema.settings).where(eq(schema.settings.id, "appConfig")).get();
    const cfg = parseReferralConfig(cfgRow?.data);
    if (event === "purchase" && cfg.minPurchaseInr > 0 && !(Number(opts.amountInr) >= cfg.minPurchaseInr)) return;
    // A fraud signal recorded when the code was applied (applyReferralCode)
    // holds this referral for an admin even when the program pays automatically.
    const next: ReferralStatus = cfg.requireReview || row.holdReason ? "review" : "rewarded";
    // Claim the transition first: only one caller can move it out of `pending`.
    const claim = await db
      .update(schema.referrals)
      .set({ status: next === "review" ? "review" : "pending", qualifiedAt: ts, updatedAt: ts })
      .where(and(eq(schema.referrals.id, row.id), eq(schema.referrals.status, "pending"), isNull(schema.referrals.qualifiedAt)))
      .run();
    if (Number(claim.meta?.changes || 0) === 0) return;
    if (next === "review") {
      await notifySafe(env, row.referrerUid, "Referral review mein 🕒", "Aapke dost ne qualify kar liya — reward jaldi milega.");
      return;
    }
    await payReferral(env, row.id, cfg, { ts });
  } catch (e) {
    console.error("[referral] qualify failed (continuing)", uid, event, e);
  }
}

async function notifySafe(env: Env, uid: string, title: string, body: string) {
  try {
    await createNotification(env, uid, { title, body, type: "referral", targetId: "referral" });
  } catch {
    /* best-effort */
  }
}

async function creditOnce(env: Env, uid: string, amount: number, description: string, claimKey: string): Promise<boolean> {
  if (!(amount > 0)) return false;
  // Belt and braces on top of the wallet claim: a ledger row with this id means
  // the credit already happened (e.g. under the old instant referral).
  const done = await env.DB.prepare(`SELECT 1 AS x FROM coin_transactions WHERE id = ?`).bind(claimKey).first();
  if (done) return false;
  try {
    // Free reward: play-only unless App Control says otherwise (lib/rewardLocking.ts).
    const locked = rewardLocked(await getAppConfig(env), "referral");
    await adjustUserWallet(env, {
      uid,
      amount,
      direction: "add",
      type: "referral_bonus",
      description: locked ? `${description} (Diamond)` : description,
      claimKey,
      ledgerId: claimKey,
      locked,
    });
    return true;
  } catch (err) {
    if (err instanceof WalletReplay) return false;
    throw err;
  }
}

/** An account that may receive a referral reward. */
function inGoodStanding(u: { status: string | null; isBlocked: boolean | null } | undefined): boolean {
  return !!u && !u.isBlocked && (!u.status || u.status === "active");
}

/** Start of the current calendar month, UTC (the monthly referral budget window). */
export function referralMonthStart(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

export type PayOutcome = {
  referrerReward: number;
  refereeReward: number;
  /** Why the inviter's share was 0, or why nothing was paid. */
  capped: string | null;
  status: ReferralStatus;
};

/**
 * Pay a qualified (or admin-approved) referral.
 *
 * The decision and the caps are ONE statement: the `rewarded` flip carries the
 * lifetime cap, the 24h cap and the monthly budget as sub-queries in its WHERE.
 * D1 runs statements one at a time, so two referrals of the same inviter that
 * qualify together cannot both see "one slot left" — the second one sees the
 * first one's row (AUDIT G13). Only the request whose flip applied credits the
 * coins, and each credit is claim-keyed, so a retry pays once. A crash between
 * the flip and the credits is repaired by `reconcileReferrals`.
 *
 * Outcomes:
 *  - both sides paid;
 *  - inviter over a cap or not in good standing: the friend is paid, the
 *    inviter's share is 0 with the reason;
 *  - the invited friend blocked / deleted: rejected, nobody is paid;
 *  - monthly budget used up: stays (or goes) in review with hold reason
 *    `monthly_budget`, paid later by an admin once there is room.
 */
export async function payReferral(
  env: Env,
  referralId: string,
  cfg: ReferralProgramConfig,
  opts: { ts?: number; decidedBy?: string | null; byAdmin?: boolean } = {},
): Promise<PayOutcome> {
  const ts = opts.ts ?? now();
  const db = getDb(env);
  const row = await db.select().from(schema.referrals).where(eq(schema.referrals.id, referralId)).get();
  if (!row) throw httpsError("not-found", "Referral not found.");
  if (row.status === "rewarded") {
    return { referrerReward: Number(row.referrerReward) || 0, refereeReward: Number(row.refereeReward) || 0, capped: null, status: "rewarded" };
  }
  if (row.status !== "pending" && row.status !== "review") throw httpsError("failed-precondition", `A ${row.status} referral cannot be paid.`);

  const standing = { status: schema.users.status, isBlocked: schema.users.isBlocked };
  const friend = await db.select(standing).from(schema.users).where(eq(schema.users.uid, row.referredUid)).get();
  if (!inGoodStanding(friend)) {
    // Paying a banned or deleted account would hand its coins to a farmer.
    await db
      .update(schema.referrals)
      .set({ status: "rejected", rejectReason: "referred_unavailable", decidedBy: opts.decidedBy ?? row.decidedBy ?? null, updatedAt: ts })
      .where(and(eq(schema.referrals.id, row.id), inArray(schema.referrals.status, ["pending", "review"])))
      .run();
    return { referrerReward: 0, refereeReward: 0, capped: "referred_unavailable", status: "rejected" };
  }
  const inviter = await db.select(standing).from(schema.users).where(eq(schema.users.uid, row.referrerUid)).get();
  const inviterOk = inGoodStanding(inviter);

  const refereeReward = cfg.refereeReward;
  const monthStart = referralMonthStart(ts);
  const budgetGate = `(? = 0 OR (SELECT COALESCE(SUM(referrer_reward + referee_reward), 0) FROM referrals
                                   WHERE status = 'rewarded' AND rewarded_at >= ?) + ? <= ?)`;
  const capGate = `(? = 0 OR (SELECT COUNT(*) FROM referrals
                               WHERE referrer_uid = ? AND status = 'rewarded' AND referrer_reward > 0) < ?)
               AND (? = 0 OR (SELECT COUNT(*) FROM referrals
                               WHERE referrer_uid = ? AND status = 'rewarded' AND referrer_reward > 0 AND rewarded_at >= ?) < ?)`;
  const flip = async (referrerReward: number, reason: string | null, withCaps: boolean): Promise<boolean> => {
    const sqlText = `UPDATE referrals
        SET status = 'rewarded', referrer_reward = ?, referee_reward = ?, bonus = ?, rewarded_at = ?,
            qualified_at = COALESCE(qualified_at, ?), reject_reason = ?, decided_by = ?, updated_at = ?
      WHERE id = ? AND status IN ('pending', 'review')
        AND ${budgetGate}
        ${withCaps ? `AND ${capGate}` : ""}`;
    const binds: unknown[] = [
      referrerReward, refereeReward, referrerReward, ts, ts, reason, opts.decidedBy ?? row.decidedBy ?? null, ts,
      row.id,
      cfg.maxCoinsPerMonth, monthStart, referrerReward + refereeReward, cfg.maxCoinsPerMonth,
    ];
    if (withCaps) {
      binds.push(
        cfg.maxRewardedPerReferrer, row.referrerUid, cfg.maxRewardedPerReferrer,
        cfg.maxRewardedPerReferrerPerDay, row.referrerUid, ts - DAY, cfg.maxRewardedPerReferrerPerDay,
      );
    }
    const res = await env.DB.prepare(sqlText).bind(...binds).run();
    return Number(res.meta?.changes || 0) > 0;
  };

  let referrerReward = inviterOk ? cfg.referrerReward : 0;
  let capped: string | null = inviterOk ? null : "referrer_unavailable";
  let applied = referrerReward > 0 ? await flip(referrerReward, null, true) : await flip(0, capped, false);
  if (!applied && referrerReward > 0) {
    // Over a cap, or over the budget with the inviter's share. Try the friend's
    // share alone, labelled with the cap that blocked the inviter.
    const counts = await env.DB.prepare(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN rewarded_at >= ? THEN 1 ELSE 0 END) AS today
         FROM referrals WHERE referrer_uid = ? AND status = 'rewarded' AND referrer_reward > 0`,
    )
      .bind(ts - DAY, row.referrerUid)
      .first<{ total: number; today: number }>();
    if (cfg.maxRewardedPerReferrer > 0 && Number(counts?.total || 0) >= cfg.maxRewardedPerReferrer) capped = "referrer_lifetime_cap";
    else if (cfg.maxRewardedPerReferrerPerDay > 0 && Number(counts?.today || 0) >= cfg.maxRewardedPerReferrerPerDay) capped = "referrer_daily_cap";
    if (capped) {
      referrerReward = 0;
      applied = await flip(0, capped, false);
    }
  }
  if (!applied) {
    const cur = await db.select().from(schema.referrals).where(eq(schema.referrals.id, row.id)).get();
    if (cur && cur.status === "rewarded") {
      // Someone else paid it a moment ago.
      return { referrerReward: Number(cur.referrerReward) || 0, refereeReward: Number(cur.refereeReward) || 0, capped: null, status: "rewarded" };
    }
    if (cur && (cur.status === "pending" || cur.status === "review")) {
      // The only gate left is the monthly budget: wait for an admin.
      await db
        .update(schema.referrals)
        .set({ status: "review", holdReason: "monthly_budget", qualifiedAt: cur.qualifiedAt ?? ts, updatedAt: ts })
        .where(and(eq(schema.referrals.id, row.id), inArray(schema.referrals.status, ["pending", "review"])))
        .run();
      if (opts.byAdmin) throw httpsError("failed-precondition", "Is mahine ka referral budget khatam ho gaya hai. Budget badhao ya agle mahine approve karo.");
      return { referrerReward: 0, refereeReward: 0, capped: "monthly_budget", status: "review" };
    }
    throw httpsError("failed-precondition", `A ${cur?.status ?? "missing"} referral cannot be paid.`);
  }

  await creditReferralSides(env, row.referredUid, row.referrerUid, refereeReward, referrerReward);

  // Referral rewards are Diamonds unless App Control pays them as DP coins.
  const unit = await referralUnit(env);
  if (refereeReward > 0) await notifySafe(env, row.referredUid, "Referral reward mil gaya! 🎉", `${refereeReward} ${unit} aapke wallet mein aa gaye.`);
  if (referrerReward > 0) await notifySafe(env, row.referrerUid, "Referral bonus! 🎉", `Aapke dost ne qualify kiya — ${referrerReward} ${unit} aapke wallet mein.`);
  if (referrerReward > 0) await payMilestones(env, row.referrerUid, cfg);
  return { referrerReward, refereeReward, capped, status: "rewarded" };
}

/**
 * The two claim-keyed credits of a rewarded referral. The keys are the ones the
 * old instant referral used, so an account paid under the old rule is never paid
 * again. A failure is logged, not thrown: the referral is already `rewarded`
 * and the cron re-runs the missing credit.
 */
async function creditReferralSides(env: Env, referredUid: string, referrerUid: string, refereeReward: number, referrerReward: number) {
  for (const [uid, amount, desc, key] of [
    [referredUid, refereeReward, "Referral welcome bonus", `referral_bonus:referred:${referredUid}`],
    [referrerUid, referrerReward, "Referral bonus — invited a friend", `referral_bonus:referrer:${referredUid}`],
  ] as const) {
    try {
      await creditOnce(env, uid, amount, desc, key);
    } catch (e) {
      console.error("[referral] credit failed (cron will retry)", key, e);
    }
  }
}

/** "Diamond" or "DP coin": how referral rewards are credited (lib/rewardLocking.ts). */
async function referralUnit(env: Env): Promise<string> {
  return rewardLocked(await getAppConfig(env), "referral") ? "Diamond" : "DP coin";
}

/** Milestone bonuses: one claim-keyed credit per tier reached. */
async function payMilestones(env: Env, referrerUid: string, cfg: ReferralProgramConfig): Promise<void> {
  if (!cfg.milestones.length) return;
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM referrals WHERE referrer_uid = ? AND status = 'rewarded' AND referrer_reward > 0`)
    .bind(referrerUid)
    .first<{ n: number }>();
  const n = Number(r?.n || 0);
  for (const m of cfg.milestones) {
    if (n < m.count) break;
    const paid = await creditOnce(env, referrerUid, m.bonus, `Referral milestone — ${m.count} friends joined`, `referral_milestone:${referrerUid}:${m.count}`);
    if (paid) await notifySafe(env, referrerUid, `Milestone unlocked: ${m.count} referrals 🏆`, `${m.bonus} bonus ${await referralUnit(env)} aapke wallet mein.`);
  }
}

/**
 * Cron:
 *  - pending referrals past their qualify window (and never qualified) expire;
 *  - a referral that qualified but whose payout was interrupted (a crash between
 *    the claim and the flip) is paid now — every step is idempotent;
 *  - a `rewarded` referral whose credit did not land (a crash between the flip
 *    and the credit) gets the missing credit;
 *  - referrals held only by the monthly budget are retried, so they pay
 *    themselves once a new month (or a bigger budget) has room.
 */
export async function reconcileReferrals(env: Env, nowMs: number = now()): Promise<{ expired: number; paid: number; repaired: number }> {
  const res = await env.DB.prepare(
    `UPDATE referrals SET status = 'expired', updated_at = ?
      WHERE status = 'pending' AND qualified_at IS NULL AND expires_at IS NOT NULL AND expires_at < ?`,
  )
    .bind(nowMs, nowMs)
    .run();
  const cfgRow = await getDb(env).select({ data: schema.settings.data }).from(schema.settings).where(eq(schema.settings.id, "appConfig")).get();
  const cfg = parseReferralConfig(cfgRow?.data);
  const stuck = await env.DB.prepare(
    `SELECT id FROM referrals
      WHERE (status = 'pending' AND qualified_at IS NOT NULL AND qualified_at < ?)
         OR (? = 0 AND status = 'review' AND hold_reason = 'monthly_budget')
      LIMIT 25`,
  )
    .bind(nowMs - 5 * 60 * 1000, cfg.requireReview ? 1 : 0)
    .all<{ id: string }>();
  let paid = 0;
  for (const r of stuck.results ?? []) {
    try {
      const out = await payReferral(env, r.id, cfg, { ts: nowMs });
      if (out.status === "rewarded") paid++;
    } catch (e) {
      console.error("[referral] reconcile pay failed (will retry)", r.id, e);
    }
  }
  // Rewarded in the last week, older than 5 minutes, with a credit missing.
  const missing = await env.DB.prepare(
    `SELECT r.referred_uid AS referredUid, r.referrer_uid AS referrerUid, r.referee_reward AS refereeReward, r.referrer_reward AS referrerReward
       FROM referrals r
      WHERE r.status = 'rewarded' AND r.rewarded_at < ? AND r.rewarded_at >= ?
        AND (
          (r.referee_reward > 0 AND EXISTS (SELECT 1 FROM users WHERE uid = r.referred_uid)
             AND NOT EXISTS (SELECT 1 FROM coin_transactions WHERE id = 'referral_bonus:referred:' || r.referred_uid))
          OR
          (r.referrer_reward > 0 AND EXISTS (SELECT 1 FROM users WHERE uid = r.referrer_uid)
             AND NOT EXISTS (SELECT 1 FROM coin_transactions WHERE id = 'referral_bonus:referrer:' || r.referred_uid))
        )
      LIMIT 25`,
  )
    .bind(nowMs - 5 * 60 * 1000, nowMs - 7 * DAY)
    .all<{ referredUid: string; referrerUid: string; refereeReward: number; referrerReward: number }>();
  let repaired = 0;
  for (const m of missing.results ?? []) {
    await creditReferralSides(env, m.referredUid, m.referrerUid, Number(m.refereeReward) || 0, Number(m.referrerReward) || 0);
    repaired++;
  }
  return { expired: Number(res.meta?.changes || 0), paid, repaired };
}

// ---------------------------------------------------------------------------
// Admin decisions
// ---------------------------------------------------------------------------

export async function decideReferral(
  env: Env,
  id: string,
  action: "approve" | "reject",
  adminUid: string | null,
  reason?: string,
): Promise<{ status: ReferralStatus }> {
  const db = getDb(env);
  const row = await db.select().from(schema.referrals).where(eq(schema.referrals.id, id)).get();
  if (!row) throw httpsError("not-found", "Referral not found.");
  const ts = now();
  if (action === "reject") {
    if (!["pending", "review"].includes(row.status)) throw httpsError("failed-precondition", `A ${row.status} referral cannot be rejected.`);
    const res = await db
      .update(schema.referrals)
      .set({ status: "rejected", rejectReason: String(reason || "admin_rejected").slice(0, 200), decidedBy: adminUid, updatedAt: ts })
      .where(and(eq(schema.referrals.id, id), inArray(schema.referrals.status, ["pending", "review"])))
      .run();
    if (Number(res.meta?.changes || 0) === 0) throw httpsError("failed-precondition", "Referral was already decided.");
    return { status: "rejected" };
  }
  if (!["pending", "review"].includes(row.status)) throw httpsError("failed-precondition", `A ${row.status} referral cannot be approved.`);
  const cfgRow = await db.select({ data: schema.settings.data }).from(schema.settings).where(eq(schema.settings.id, "appConfig")).get();
  const out = await payReferral(env, id, parseReferralConfig(cfgRow?.data), { ts, decidedBy: adminUid, byAdmin: true });
  return { status: out.status };
}

export interface ReversalSide {
  uid: string;
  /** Coins credited by the referral. */
  credited: number;
  /** Coins taken back (less than `credited` if the user already spent them). */
  taken: number;
  unit: "Diamond" | "DP coin";
}

/**
 * Claw back a paid referral (fake account found later, refunded purchase…).
 *
 * The `rewarded → reversed` flip is a compare-and-swap, so only one admin
 * request runs the debits. Each side gives back what its credit added, from the
 * same balance it went to (Diamond or DP coin, read off the ledger row), up to
 * what is still there: coins already spent on contests cannot be pulled back
 * without driving a balance negative, so the shortfall is reported instead.
 * Debits are claim-keyed (`referral_reversal:…`), so a retry takes nothing twice.
 * Milestone bonuses already paid are not touched.
 */
export async function reverseReferral(
  env: Env,
  id: string,
  adminUid: string | null,
  reason: string,
): Promise<{ status: ReferralStatus; sides: ReversalSide[] }> {
  const db = getDb(env);
  const row = await db.select().from(schema.referrals).where(eq(schema.referrals.id, id)).get();
  if (!row) throw httpsError("not-found", "Referral not found.");
  if (row.status !== "rewarded") throw httpsError("failed-precondition", `Only a rewarded referral can be reversed (this one is ${row.status}).`);
  const ts = now();
  const flip = await db
    .update(schema.referrals)
    .set({ status: "reversed", rejectReason: String(reason || "admin_reversed").slice(0, 200), decidedBy: adminUid, updatedAt: ts })
    .where(and(eq(schema.referrals.id, id), eq(schema.referrals.status, "rewarded")))
    .run();
  if (Number(flip.meta?.changes || 0) === 0) throw httpsError("failed-precondition", "Referral was already reversed.");

  const sides: ReversalSide[] = [];
  for (const [uid, side] of [
    [row.referredUid, "referred"],
    [row.referrerUid, "referrer"],
  ] as const) {
    const credit = await env.DB.prepare(`SELECT amount, locked_delta FROM coin_transactions WHERE id = ?`)
      .bind(`referral_bonus:${side}:${row.referredUid}`)
      .first<{ amount: number; locked_delta: number | null }>();
    const credited = Math.max(0, Number(credit?.amount) || 0);
    if (!credited) continue;
    const diamond = Number(credit?.locked_delta || 0) > 0;
    const bal = await env.DB.prepare(`SELECT dpcoin, locked_coins FROM users WHERE uid = ?`).bind(uid).first<{ dpcoin: number; locked_coins: number }>();
    const dp = Number(bal?.dpcoin) || 0;
    const locked = Number(bal?.locked_coins) || 0;
    const available = !bal ? 0 : diamond ? Math.min(locked, dp) : Math.max(0, dp - locked);
    const take = Math.floor(Math.min(credited, available));
    let taken = 0;
    if (take > 0) {
      try {
        await adjustUserWallet(env, {
          uid,
          amount: take,
          direction: "subtract",
          type: "referral_clawback",
          description: `Referral reversed: ${String(reason || "admin").slice(0, 80)}${diamond ? " (Diamond)" : ""}`,
          claimKey: `referral_reversal:${side}:${row.referredUid}`,
          ledgerId: `referral_reversal:${side}:${row.referredUid}`,
          locked: diamond,
          ts,
        });
        taken = take;
      } catch (err) {
        if (!(err instanceof WalletReplay)) console.error("[referral] clawback failed", id, side, err);
      }
    }
    sides.push({ uid, credited, taken, unit: diamond ? "Diamond" : "DP coin" });
  }
  return { status: "reversed", sides };
}

/**
 * Accounts linked to a referral by device or network, for an admin judging
 * whether the friend is a real person. Read-only.
 */
export async function referralLinks(env: Env, id: string) {
  const row = await getDb(env).select().from(schema.referrals).where(eq(schema.referrals.id, id)).get();
  if (!row) throw httpsError("not-found", "Referral not found.");
  const userCols = `u.uid, u.username, u.created_at AS createdAt, u.is_blocked AS isBlocked, u.status`;
  const deviceIds = [row.deviceId].filter(Boolean) as string[];
  const friendDevice = await env.DB.prepare(`SELECT device_id AS d FROM users WHERE uid = ?`).bind(row.referredUid).first<{ d: string | null }>();
  if (friendDevice?.d && !deviceIds.includes(friendDevice.d)) deviceIds.push(friendDevice.d);
  const sameDevice = deviceIds.length
    ? (
        await env.DB.prepare(
          `SELECT ${userCols} FROM users u
            WHERE u.device_id IN (${deviceIds.map(() => "?").join(",")}) AND u.uid != ?
            UNION
           SELECT ${userCols} FROM referrals r JOIN users u ON u.uid = r.referred_uid
            WHERE r.device_id IN (${deviceIds.map(() => "?").join(",")}) AND r.referred_uid != ?
            LIMIT 50`,
        )
          .bind(...deviceIds, row.referredUid, ...deviceIds, row.referredUid)
          .all()
      ).results ?? []
    : [];
  const sameIp = row.ip
    ? (
        await env.DB.prepare(
          `SELECT r.id, r.referred_uid AS uid, u.username, r.referrer_uid AS referrerUid, ru.username AS referrerUsername,
                  r.status, r.created_at AS createdAt
             FROM referrals r
             LEFT JOIN users u ON u.uid = r.referred_uid
             LEFT JOIN users ru ON ru.uid = r.referrer_uid
            WHERE r.ip = ? AND r.id != ?
            ORDER BY r.created_at DESC LIMIT 50`,
        )
          .bind(row.ip, row.id)
          .all()
      ).results ?? []
    : [];
  // The inviter's other referrals grouped by IP: one address behind many
  // "friends" is the usual farm.
  const inviterIps = (
    await env.DB.prepare(
      `SELECT COALESCE(ip, '') AS ip, COUNT(*) AS n,
              SUM(CASE WHEN status = 'rewarded' THEN 1 ELSE 0 END) AS rewarded
         FROM referrals WHERE referrer_uid = ? GROUP BY COALESCE(ip, '') ORDER BY n DESC LIMIT 20`,
    )
      .bind(row.referrerUid)
      .all()
  ).results ?? [];
  return {
    referral: { id: row.id, referrerUid: row.referrerUid, referredUid: row.referredUid, deviceId: row.deviceId, ip: row.ip },
    sameDevice,
    sameIp,
    inviterIps,
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** The signed-in user's referral dashboard. */
export async function referralSummary(env: Env, uid: string, origin: string) {
  const db = getDb(env);
  const code = await ensureReferralCode(env, uid);
  const cfgRow = await db.select({ data: schema.settings.data }).from(schema.settings).where(eq(schema.settings.id, "appConfig")).get();
  const cfg = parseReferralConfig(cfgRow?.data);
  const me = await db.select({ createdAt: schema.users.createdAt, referredBy: schema.users.referredBy }).from(schema.users).where(eq(schema.users.uid, uid)).get();
  const rows = await db
    .select({
      id: schema.referrals.id,
      status: schema.referrals.status,
      referrerReward: schema.referrals.referrerReward,
      rejectReason: schema.referrals.rejectReason,
      createdAt: schema.referrals.createdAt,
      rewardedAt: schema.referrals.rewardedAt,
      expiresAt: schema.referrals.expiresAt,
      username: schema.users.username,
      avatar: schema.users.profileImageUrl,
    })
    .from(schema.referrals)
    .leftJoin(schema.users, eq(schema.users.uid, schema.referrals.referredUid))
    .where(eq(schema.referrals.referrerUid, uid))
    .orderBy(desc(schema.referrals.createdAt))
    .limit(100)
    .all();
  const all = await env.DB.prepare(
    `SELECT COUNT(*) AS invited,
            SUM(CASE WHEN status = 'rewarded' AND referrer_reward > 0 THEN 1 ELSE 0 END) AS successful,
            SUM(CASE WHEN status IN ('pending','review') THEN 1 ELSE 0 END) AS pending,
            COALESCE(SUM(CASE WHEN status = 'rewarded' THEN referrer_reward ELSE 0 END), 0) AS earned
       FROM referrals WHERE referrer_uid = ?`,
  )
    .bind(uid)
    .first<{ invited: number; successful: number; pending: number; earned: number }>();
  const milestoneEarned = await env.DB.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS s FROM coin_transactions WHERE uid = ? AND id LIKE 'referral_milestone:%'`,
  )
    .bind(uid)
    .first<{ s: number }>();
  const mine = await db.select({ status: schema.referrals.status, refereeReward: schema.referrals.refereeReward, qualifyAction: schema.referrals.qualifyAction, expiresAt: schema.referrals.expiresAt }).from(schema.referrals).where(eq(schema.referrals.referredUid, uid)).get();
  const ts = now();
  const canApply =
    cfg.enabled && !me?.referredBy && !mine && !!me && ts - Number(me.createdAt) <= Math.max(1, cfg.applyWindowDays) * DAY;
  return {
    program: publicReferralConfig(cfg, cfgRow?.data),
    code,
    link: code ? `${origin.replace(/\/$/, "")}/invite/${encodeURIComponent(code)}` : null,
    stats: {
      invited: Number(all?.invited || 0),
      successful: Number(all?.successful || 0),
      pending: Number(all?.pending || 0),
      earned: Number(all?.earned || 0) + Number(milestoneEarned?.s || 0),
    },
    referrals: rows.map((r) => ({
      id: r.id,
      username: r.username ?? null,
      avatarUrl: r.avatar ?? null,
      status: r.status,
      reward: Number(r.referrerReward) || 0,
      createdAt: r.createdAt,
      rewardedAt: r.rewardedAt,
      expiresAt: r.expiresAt,
    })),
    referredBy: mine
      ? { status: mine.status, reward: Number(mine.refereeReward) || 0, qualifyAction: mine.qualifyAction, expiresAt: mine.expiresAt }
      : null,
    canApply,
    applyUntil: me ? Number(me.createdAt) + Math.max(1, cfg.applyWindowDays) * DAY : null,
  };
}
