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

export const QUALIFY_ACTIONS = ["signup", "verified", "first_contest", "first_purchase"] as const;
export type QualifyAction = (typeof QUALIFY_ACTIONS)[number];
export type ReferralEvent = "signup" | "verified" | "contest" | "purchase";
export const REFERRAL_STATUSES = ["pending", "review", "rewarded", "rejected", "expired"] as const;
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

/** What the app may show before sign-in (public app config). */
export function publicReferralConfig(cfg: ReferralProgramConfig) {
  return {
    enabled: cfg.enabled,
    referrerReward: cfg.referrerReward,
    refereeReward: cfg.refereeReward,
    qualifyAction: cfg.qualifyAction,
    applyWindowDays: cfg.applyWindowDays,
    qualifyWindowDays: cfg.qualifyWindowDays,
    milestones: cfg.milestones,
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
  opts: { deviceId?: string | null; nowMs?: number } = {},
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
      .where(and(eq(schema.referrals.deviceId, deviceId), inArray(schema.referrals.status, ["pending", "review", "rewarded"])))
      .get();
    if (reused) rejectReason = "device_already_used";
  }

  const id = newId();
  const status: ReferralStatus = rejectReason ? "rejected" : "pending";
  const res = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO referrals
         (id, referrer_uid, referred_uid, bonus, created_at, status, code, qualify_action, expires_at, reject_reason, device_id, updated_at)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, referrer.uid, uid, ts, status, code, cfg.qualifyAction, ts + cfg.qualifyWindowDays * DAY, rejectReason, deviceId, ts),
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
 */
export async function qualifyReferral(env: Env, uid: string, event: ReferralEvent, opts: { nowMs?: number } = {}): Promise<void> {
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
    const next: ReferralStatus = cfg.requireReview ? "review" : "rewarded";
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
    await adjustUserWallet(env, { uid, amount, direction: "add", type: "referral_bonus", description, claimKey, ledgerId: claimKey });
    return true;
  } catch (err) {
    if (err instanceof WalletReplay) return false;
    throw err;
  }
}

/**
 * Pay a qualified (or admin-approved) referral. Idempotent end to end: the
 * credits are claim-keyed per referred user, and the final `rewarded` flip is a
 * compare-and-swap, so running twice pays once.
 */
export async function payReferral(
  env: Env,
  referralId: string,
  cfg: ReferralProgramConfig,
  opts: { ts?: number; decidedBy?: string | null } = {},
): Promise<{ referrerReward: number; refereeReward: number; capped: string | null }> {
  const ts = opts.ts ?? now();
  const db = getDb(env);
  const row = await db.select().from(schema.referrals).where(eq(schema.referrals.id, referralId)).get();
  if (!row) throw httpsError("not-found", "Referral not found.");
  if (row.status === "rewarded") return { referrerReward: Number(row.referrerReward) || 0, refereeReward: Number(row.refereeReward) || 0, capped: null };
  if (row.status !== "pending" && row.status !== "review") throw httpsError("failed-precondition", `A ${row.status} referral cannot be paid.`);

  // Referrer still in good standing?
  const ref = await db.select({ status: schema.users.status, isBlocked: schema.users.isBlocked }).from(schema.users).where(eq(schema.users.uid, row.referrerUid)).get();
  let capped: string | null = null;
  if (!ref || ref.isBlocked || (ref.status && ref.status !== "active")) capped = "referrer_unavailable";

  // Caps on the referrer's share (the invited user is still paid).
  if (!capped && (cfg.maxRewardedPerReferrer > 0 || cfg.maxRewardedPerReferrerPerDay > 0)) {
    const counts = await env.DB.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN rewarded_at >= ? THEN 1 ELSE 0 END) AS today
         FROM referrals WHERE referrer_uid = ? AND status = 'rewarded' AND referrer_reward > 0`,
    )
      .bind(ts - DAY, row.referrerUid)
      .first<{ total: number; today: number }>();
    if (cfg.maxRewardedPerReferrer > 0 && Number(counts?.total || 0) >= cfg.maxRewardedPerReferrer) capped = "referrer_lifetime_cap";
    else if (cfg.maxRewardedPerReferrerPerDay > 0 && Number(counts?.today || 0) >= cfg.maxRewardedPerReferrerPerDay) capped = "referrer_daily_cap";
  }

  const referrerReward = capped ? 0 : cfg.referrerReward;
  const refereeReward = cfg.refereeReward;
  // Existing claim keys — the same ones the old instant referral used — so an
  // account paid under the old rule can never be paid again.
  await creditOnce(env, row.referredUid, refereeReward, "Referral welcome bonus", `referral_bonus:referred:${row.referredUid}`);
  await creditOnce(env, row.referrerUid, referrerReward, "Referral bonus — invited a friend", `referral_bonus:referrer:${row.referredUid}`);

  const flip = await db
    .update(schema.referrals)
    .set({
      status: "rewarded",
      referrerReward,
      refereeReward,
      bonus: referrerReward,
      rewardedAt: ts,
      qualifiedAt: row.qualifiedAt ?? ts,
      rejectReason: capped,
      decidedBy: opts.decidedBy ?? row.decidedBy ?? null,
      updatedAt: ts,
    })
    .where(and(eq(schema.referrals.id, row.id), inArray(schema.referrals.status, ["pending", "review"])))
    .run();
  if (Number(flip.meta?.changes || 0) === 0) return { referrerReward, refereeReward, capped };

  if (refereeReward > 0) await notifySafe(env, row.referredUid, "Referral reward mil gaya! 🎉", `${refereeReward} coins aapke wallet mein aa gaye.`);
  if (referrerReward > 0) await notifySafe(env, row.referrerUid, "Referral bonus! 🎉", `Aapke dost ne qualify kiya — ${referrerReward} coins aapke wallet mein.`);
  if (!capped) await payMilestones(env, row.referrerUid, cfg);
  return { referrerReward, refereeReward, capped };
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
    if (paid) await notifySafe(env, referrerUid, `Milestone unlocked: ${m.count} referrals 🏆`, `${m.bonus} bonus coins aapke wallet mein.`);
  }
}

/**
 * Cron:
 *  - pending referrals past their qualify window (and never qualified) expire;
 *  - a referral that qualified but whose payout was interrupted (a crash between
 *    the claim and the credit) is paid now — every step is idempotent.
 */
export async function reconcileReferrals(env: Env, nowMs: number = now()): Promise<{ expired: number; paid: number }> {
  const res = await env.DB.prepare(
    `UPDATE referrals SET status = 'expired', updated_at = ?
      WHERE status = 'pending' AND qualified_at IS NULL AND expires_at IS NOT NULL AND expires_at < ?`,
  )
    .bind(nowMs, nowMs)
    .run();
  const stuck = await env.DB.prepare(
    `SELECT id FROM referrals WHERE status = 'pending' AND qualified_at IS NOT NULL AND qualified_at < ? LIMIT 25`,
  )
    .bind(nowMs - 5 * 60 * 1000)
    .all<{ id: string }>();
  let paid = 0;
  if (stuck.results?.length) {
    const cfgRow = await getDb(env).select({ data: schema.settings.data }).from(schema.settings).where(eq(schema.settings.id, "appConfig")).get();
    const cfg = parseReferralConfig(cfgRow?.data);
    for (const r of stuck.results) {
      try {
        await payReferral(env, r.id, cfg, { ts: nowMs });
        paid++;
      } catch (e) {
        console.error("[referral] reconcile pay failed (will retry)", r.id, e);
      }
    }
  }
  return { expired: Number(res.meta?.changes || 0), paid };
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
  await payReferral(env, id, parseReferralConfig(cfgRow?.data), { ts, decidedBy: adminUid });
  return { status: "rewarded" };
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
    program: publicReferralConfig(cfg),
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
