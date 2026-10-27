/**
 * Promo budgets — the only way the platform gives away coins it was not paid for.
 *
 * Two kinds of offer can cost the platform coins:
 *
 *   package_bonus   bonus coins on a coin package beyond what its price covers
 *   contest_prize   the part of a contest prize that is larger than the pot the
 *                   two players funded
 *   product_prize   the coin cost of a physical prize (set by the admin, never
 *                   shown to users) above the pot, per match won
 *   free_rewards    a cap on daily login + rewarded ads + daily task coins
 *                   (appConfig.freeRewardsBudgetId); when it runs out those
 *                   rewards pause until the admin raises it
 *
 * Each offer has its OWN budget (`promo_budgets`), with a hard coin limit, an
 * optional time window and an optional per-user limit. Coins are set aside
 * (`promo_reservations`) before anything is promised to a user and only counted
 * as spent when they are actually credited, so a budget can never pay out more
 * than its total:
 *
 *   room = total_coins − spent_coins − Σ(held reservations that have not expired)
 *
 * Every coin a budget pays is also written to `platform_ledger` with a negative
 * amount (platform expense), next to the user's own `coin_transactions` row, so
 * the admin can see exactly where each promo coin went.
 *
 * Package bonus coins from a budget are credited as LOCKED coins
 * (`users.locked_coins`): they can be spent on contest entry fees but never
 * withdrawn. That is what makes a "loss-making" package safe to sell — the bonus
 * can be played with, not cashed out.
 *
 * All statements here are plain prepared statements meant to be placed inside
 * the caller's existing gated `DB.batch`, with the caller's gate appended, so a
 * promo credit applies in the same transaction as the money movement it belongs
 * to — or not at all.
 */
import type { Env } from "../types";
import { httpsError } from "./http";
import { MAX_COIN_AMOUNT } from "./money";
import { getAppConfig } from "./settings";
import { sendEmail } from "./email";

export const BUDGET_KINDS = ["package_bonus", "contest_prize", "product_prize", "free_rewards"] as const;
export type BudgetKind = (typeof BUDGET_KINDS)[number];
export const BUDGET_STATUSES = ["active", "paused", "closed"] as const;
export type BudgetStatus = (typeof BUDGET_STATUSES)[number];

/** How long a Razorpay checkout keeps its bonus reserved before it stops counting. */
export const ORDER_RESERVATION_TTL_MS = 60 * 60 * 1000;

/** Reservation ids are deterministic so a retry can never reserve twice. */
export const orderReservationId = (orderId: string) => `order:${orderId}`;
export const depositReservationId = (depositId: string) => `deposit:${depositId}`;
export const matchReservationId = (matchId: string) => `match:${matchId}`;

/**
 * Coins of a budget currently set aside and not yet spent, as a correlated
 * subquery on `promo_budgets b`. Expired holds (an abandoned checkout) stop
 * counting on their own, so nothing has to sweep them for the room to be right.
 */
const HELD_SUM = `COALESCE((SELECT SUM(r.coins) FROM promo_reservations r
   WHERE r.budget_id = b.id AND r.status = 'held'
     AND (r.expires_at IS NULL OR r.expires_at > ?)), 0)`;

/** What one user has already taken (or has on hold) from a budget. */
const USER_TAKEN = `COALESCE((SELECT SUM(r2.coins) FROM promo_reservations r2
   WHERE r2.budget_id = b.id AND r2.uid = ?
     AND (r2.status = 'used' OR (r2.status = 'held' AND (r2.expires_at IS NULL OR r2.expires_at > ?)))), 0)`;

export interface ReserveInput {
  id: string;
  budgetId: string;
  kind: BudgetKind;
  /** The recipient, for the per-user limit. Null skips the per-user check. */
  uid: string | null;
  coins: number;
  refType: "order" | "deposit" | "match" | "free";
  refId: string;
  expiresAt: number | null;
  ts: number;
  /** Extra `AND …` condition from the caller's batch (e.g. a solvency gate). */
  gate?: string;
  gateArgs?: unknown[];
}

/**
 * INSERT a hold, but only if the budget is live and can still cover it.
 *
 * One statement, so the room check and the hold are atomic: D1 runs a batch as a
 * single serialized transaction, and two buyers racing for the last coins of a
 * budget see each other's holds. The caller learns whether it got the hold from
 * `meta.changes` (or by reading the reservation row back inside the same batch).
 */
export function reserveStatement(env: Env, r: ReserveInput): D1PreparedStatement {
  const gate = r.gate ? `AND ${r.gate}` : "";
  return env.DB.prepare(
    `INSERT OR IGNORE INTO promo_reservations
       (id, budget_id, uid, coins, status, ref_type, ref_id, expires_at, created_at, updated_at)
     SELECT ?, ?, ?, ?, 'held', ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM promo_budgets b
         WHERE b.id = ? AND b.kind = ? AND b.status = 'active'
           AND (b.starts_at IS NULL OR b.starts_at <= ?)
           AND (b.ends_at IS NULL OR b.ends_at > ?)
           AND b.total_coins - b.spent_coins - ${HELD_SUM} >= ?
           AND (b.per_user_limit IS NULL OR ? IS NULL OR ${USER_TAKEN} + ? <= b.per_user_limit)
      ) ${gate}`,
  ).bind(
    r.id, r.budgetId, r.uid, r.coins, r.refType, r.refId, r.expiresAt, r.ts, r.ts,
    r.budgetId, r.kind, r.ts, r.ts, r.ts, r.coins,
    r.uid, r.uid, r.ts, r.coins,
    ...(r.gateArgs ?? []),
  );
}

/** Try to reserve on its own (outside any batch). Returns true when the hold exists. */
export async function tryReserve(env: Env, r: Omit<ReserveInput, "gate" | "gateArgs">): Promise<boolean> {
  await reserveStatement(env, r).run();
  const row = await env.DB.prepare(`SELECT status FROM promo_reservations WHERE id = ?`)
    .bind(r.id)
    .first<{ status: string }>();
  return row?.status === "held";
}

/** Give a hold back to its budget (deposit rejected, match refunded). */
export function releaseStatement(env: Env, reservationId: string, ts: number, gate?: string, gateArgs: unknown[] = []): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE promo_reservations SET status = 'released', updated_at = ?
      WHERE id = ? AND status = 'held' ${gate ? `AND ${gate}` : ""}`,
  ).bind(ts, reservationId, ...gateArgs);
}

export interface PlatformEntry {
  id: string;
  kind: "promo_bonus" | "prize_subsidy" | "product_prize" | "product_prize_reversal" | "free_reward" | "platform_fee" | "product_prize_fund";
  /** + platform income, − platform expense. */
  coins: number;
  budgetId?: string | null;
  contestId?: string | null;
  matchId?: string | null;
  uid?: string | null;
  refId?: string | null;
  description: string;
  ts: number;
}

/** Append one platform-ledger row, gated like the batch it belongs to. Idempotent on `id`. */
export function platformLedgerStatement(env: Env, e: PlatformEntry, gate?: string, gateArgs: unknown[] = []): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT OR IGNORE INTO platform_ledger
       (id, kind, coins, budget_id, contest_id, match_id, uid, ref_id, description, created_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      ${gate ? `WHERE ${gate}` : ""}`,
  ).bind(
    e.id, e.kind, e.coins, e.budgetId ?? null, e.contestId ?? null, e.matchId ?? null,
    e.uid ?? null, e.refId ?? null, e.description, e.ts, ...gateArgs,
  );
}

export interface PromoBonusCredit {
  uid: string;
  coins: number;
  budgetId: string;
  reservationId: string;
  /** Ledger row id; deterministic per purchase. */
  ledgerId: string;
  refId: string;
  description: string;
  ts: number;
}

/**
 * Credit a package's budget-funded bonus as LOCKED coins.
 *
 * Returns the statements to place in the caller's batch BEFORE its final claim
 * statement, all carrying the caller's `gate` so they apply exactly when the
 * purchase itself is credited. The bonus row is separate from the `purchase`
 * row, which then carries only the coins that were paid for.
 */
export function promoBonusCreditStatements(
  env: Env,
  p: PromoBonusCredit,
  gate: string,
  gateArgs: unknown[],
): D1PreparedStatement[] {
  return [
    env.DB.prepare(
      `INSERT OR IGNORE INTO coin_transactions
         (id, uid, amount, type, description, created_at, locked_delta, budget_id)
       SELECT ?, ?, ?, 'promo_bonus', ?, ?, ?, ?
        WHERE ${gate}`,
    ).bind(p.ledgerId, p.uid, p.coins, p.description, p.ts, p.coins, p.budgetId, ...gateArgs),
    env.DB.prepare(
      `UPDATE users SET dpcoin = dpcoin + ?, locked_coins = locked_coins + ?, updated_at = ?
        WHERE uid = ? AND ${gate}`,
    ).bind(p.coins, p.coins, p.ts, p.uid, ...gateArgs),
    env.DB.prepare(
      `UPDATE promo_budgets SET spent_coins = spent_coins + ?, updated_at = ?
        WHERE id = ? AND ${gate}`,
    ).bind(p.coins, p.ts, p.budgetId, ...gateArgs),
    platformLedgerStatement(
      env,
      {
        id: `pl:${p.ledgerId}`,
        kind: "promo_bonus",
        coins: -p.coins,
        budgetId: p.budgetId,
        uid: p.uid,
        refId: p.refId,
        description: p.description,
        ts: p.ts,
      },
      gate,
      gateArgs,
    ),
    env.DB.prepare(
      `UPDATE promo_reservations SET status = 'used', updated_at = ?
        WHERE id = ? AND ${gate}`,
    ).bind(p.ts, p.reservationId, ...gateArgs),
  ];
}

/**
 * One admin notification (and an email to `adminAlertEmail`, if set) per
 * `title` per `dedupeMs`. Best-effort: never throws. Returns true when sent.
 */
export async function adminAlert(env: Env, title: string, message: string, link = "/coin-economy", dedupeMs = 24 * 60 * 60 * 1000): Promise<boolean> {
  try {
    const ts = Date.now();
    const recent = await env.DB.prepare(`SELECT 1 AS x FROM admin_notifications WHERE title = ? AND created_at > ? LIMIT 1`)
      .bind(title, ts - dedupeMs)
      .first();
    if (recent) return false;
    await env.DB.prepare(`INSERT INTO admin_notifications (id, title, message, link, created_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), title, message, link, ts)
      .run();
    const to = String((await getAppConfig(env))?.adminAlertEmail || "");
    if (to) {
      const esc = (x: string) => x.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] as string);
      await sendEmail(env, { to, subject: `[TopHunt] ${title}`, html: `<p><b>${esc(title)}</b></p><p>${esc(message)}</p><p>Admin panel → ${esc(link)}</p>` }).catch(() => {});
    }
    return true;
  } catch (e) {
    console.error("[promoBudget] admin alert failed", title, e);
    return false;
  }
}

/**
 * Tell the admin a budget could not fund an offer (e.g. a product contest
 * refusing new matches). One notification per budget per 24 hours. Best-effort.
 */
export async function notifyBudgetExhausted(env: Env, budgetId: string, what: string): Promise<void> {
  const b = await env.DB.prepare(`SELECT name FROM promo_budgets WHERE id = ?`).bind(budgetId).first<{ name: string }>().catch(() => null);
  await adminAlert(
    env,
    `Promo budget khatam: ${b?.name ?? budgetId}`,
    `"${what}" budget ki kami se ruk gaya hai. Coin Economy → Budgets me total badhao.`,
  );
}

/**
 * Free rewards (daily login, rewarded ads, daily tasks) capped by a
 * `free_rewards` budget: the statements to put in the reward's own batch.
 *
 *   reserve      first, gated like the reward itself
 *   heldGate     add to the credit + ledger statements: they apply only if the
 *                budget had room (and the per-user limit allowed it)
 *   finalize     last: count it as spent, ledger the platform side, mark used
 *
 * With no budget configured, returns empty pieces and the reward is uncapped.
 */
export function freeRewardBudgetStatements(
  env: Env,
  p: { budgetId: string | null; refId: string; uid: string; coins: number; ts: number; label: string; gate: string; gateArgs: unknown[] },
): { reserve: D1PreparedStatement[]; heldGate: string; heldArgs: unknown[]; finalize: D1PreparedStatement[]; reservationId: string | null } {
  if (!p.budgetId || !(p.coins > 0)) return { reserve: [], heldGate: "1 = 1", heldArgs: [], finalize: [], reservationId: null };
  const id = `free:${p.refId}`;
  const held = `EXISTS (SELECT 1 FROM promo_reservations WHERE id = ? AND status = 'held')`;
  return {
    reservationId: id,
    reserve: [
      reserveStatement(env, {
        id,
        budgetId: p.budgetId,
        kind: "free_rewards",
        uid: p.uid,
        coins: p.coins,
        refType: "free",
        refId: p.refId,
        expiresAt: null,
        ts: p.ts,
        gate: p.gate,
        gateArgs: p.gateArgs,
      }),
    ],
    heldGate: held,
    heldArgs: [id],
    finalize: [
      env.DB.prepare(`UPDATE promo_budgets SET spent_coins = spent_coins + ?, updated_at = ? WHERE id = ? AND ${held}`)
        .bind(p.coins, p.ts, p.budgetId, id),
      platformLedgerStatement(env, {
        id: `pl:free:${p.refId}`,
        kind: "free_reward",
        coins: -p.coins,
        budgetId: p.budgetId,
        uid: p.uid,
        refId: p.refId,
        description: `${p.label}: ${p.coins} Diamond`,
        ts: p.ts,
      }, held, [id]),
      env.DB.prepare(`UPDATE promo_reservations SET status = 'used', updated_at = ? WHERE id = ? AND status = 'held'`).bind(p.ts, id),
    ],
  };
}

/** The configured free-rewards budget id, or null (uncapped). */
export function freeRewardsBudgetId(cfg: any): string | null {
  const id = cfg?.freeRewardsBudgetId;
  return typeof id === "string" && id ? id : null;
}

export const FREE_REWARDS_EXHAUSTED = "free_rewards_exhausted";

// ---------------------------------------------------------------------------
// Admin-side validation and reads
// ---------------------------------------------------------------------------

export interface BudgetInput {
  name?: string;
  kind?: BudgetKind;
  totalCoins?: number;
  status?: BudgetStatus;
  startsAt?: number | null;
  endsAt?: number | null;
  perUserLimit?: number | null;
  note?: string | null;
}

const has = (b: Record<string, any>, k: string) =>
  Object.prototype.hasOwnProperty.call(b, k) && b[k] !== undefined;

function wholeCoins(v: unknown, field: string, min = 1): number {
  const n = Number(v);
  if (typeof v === "boolean" || v === null || v === "" || !Number.isInteger(n) || n < min || n > MAX_COIN_AMOUNT) {
    throw httpsError("invalid-argument", `${field} must be a whole number of coins between ${min} and ${MAX_COIN_AMOUNT}.`);
  }
  return n;
}

function optionalTime(v: unknown, field: string): number | null {
  if (v === null || v === "") return null;
  const n = typeof v === "number" ? v : Date.parse(String(v));
  if (!Number.isFinite(n) || n <= 0) throw httpsError("invalid-argument", `${field} must be a valid date.`);
  return Math.round(n);
}

/** Validate a create (`creating`) or a patch. Unknown keys are ignored. */
export function validateBudgetInput(body: Record<string, any>, creating: boolean): BudgetInput {
  const out: BudgetInput = {};
  if (has(body, "name") || creating) {
    const name = String(body.name ?? "").trim();
    if (name.length < 2 || name.length > 120) throw httpsError("invalid-argument", "Budget name must be 2–120 characters.");
    out.name = name;
  }
  if (creating) {
    if (!BUDGET_KINDS.includes(body.kind)) {
      throw httpsError("invalid-argument", `kind must be one of: ${BUDGET_KINDS.join(", ")}.`);
    }
    out.kind = body.kind;
  } else if (has(body, "kind")) {
    throw httpsError("invalid-argument", "A budget's kind cannot be changed. Create a new budget instead.");
  }
  if (has(body, "totalCoins") || creating) out.totalCoins = wholeCoins(body.totalCoins, "totalCoins");
  if (has(body, "status")) {
    if (!BUDGET_STATUSES.includes(body.status)) {
      throw httpsError("invalid-argument", `status must be one of: ${BUDGET_STATUSES.join(", ")}.`);
    }
    out.status = body.status;
  }
  if (has(body, "startsAt")) out.startsAt = optionalTime(body.startsAt, "startsAt");
  if (has(body, "endsAt")) out.endsAt = optionalTime(body.endsAt, "endsAt");
  if (has(body, "perUserLimit")) {
    out.perUserLimit = body.perUserLimit === null || body.perUserLimit === "" ? null : wholeCoins(body.perUserLimit, "perUserLimit");
  }
  if (has(body, "note")) {
    const note = body.note === null ? null : String(body.note).trim();
    if (note && note.length > 500) throw httpsError("invalid-argument", "Note must be at most 500 characters.");
    out.note = note || null;
  }
  return out;
}

/** Every budget-changing admin action needs a written reason (kept in the audit log). */
export function requireReason(body: Record<string, any>): string {
  const reason = String(body?.reason ?? "").trim();
  if (reason.length < 3) throw httpsError("invalid-argument", "Reason likho (kam se kam 3 characters) — ye audit log me jayega.");
  if (reason.length > 500) throw httpsError("invalid-argument", "Reason must be at most 500 characters.");
  return reason;
}

export interface BudgetSummary {
  id: string;
  name: string;
  kind: BudgetKind;
  status: BudgetStatus;
  totalCoins: number;
  spentCoins: number;
  heldCoins: number;
  remainingCoins: number;
  startsAt: number | null;
  endsAt: number | null;
  perUserLimit: number | null;
  note: string | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
  /** active, inside its window and with room left: offers using it are live. */
  live: boolean;
  usedCount: number;
  heldCount: number;
  linkedPackages: number;
  linkedContests: number;
}

const SUMMARY_SQL = `
  SELECT b.*,
         ${HELD_SUM} AS held_coins,
         (SELECT COUNT(*) FROM promo_reservations r WHERE r.budget_id = b.id AND r.status = 'used') AS used_count,
         (SELECT COUNT(*) FROM promo_reservations r WHERE r.budget_id = b.id AND r.status = 'held'
             AND (r.expires_at IS NULL OR r.expires_at > ?)) AS held_count,
         (SELECT COUNT(*) FROM coin_packages p WHERE p.budget_id = b.id) AS linked_packages,
         (SELECT COUNT(*) FROM contests ct WHERE ct.subsidy_budget_id = b.id) AS linked_contests
    FROM promo_budgets b`;

function toSummary(r: any, ts: number): BudgetSummary {
  const total = Number(r.total_coins) || 0;
  const spent = Number(r.spent_coins) || 0;
  const held = Number(r.held_coins) || 0;
  const remaining = Math.max(0, total - spent - held);
  const inWindow = (r.starts_at == null || r.starts_at <= ts) && (r.ends_at == null || r.ends_at > ts);
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    status: r.status,
    totalCoins: total,
    spentCoins: spent,
    heldCoins: held,
    remainingCoins: remaining,
    startsAt: r.starts_at ?? null,
    endsAt: r.ends_at ?? null,
    perUserLimit: r.per_user_limit ?? null,
    note: r.note ?? null,
    createdBy: r.created_by ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    live: r.status === "active" && inWindow && remaining > 0,
    usedCount: Number(r.used_count) || 0,
    heldCount: Number(r.held_count) || 0,
    linkedPackages: Number(r.linked_packages) || 0,
    linkedContests: Number(r.linked_contests) || 0,
  };
}

export async function listBudgets(env: Env, ts = Date.now()): Promise<BudgetSummary[]> {
  const res = await env.DB.prepare(`${SUMMARY_SQL} ORDER BY b.created_at DESC`).bind(ts, ts).all<any>();
  return (res.results ?? []).map((r) => toSummary(r, ts));
}

export async function getBudget(env: Env, id: string, ts = Date.now()): Promise<BudgetSummary | null> {
  const r = await env.DB.prepare(`${SUMMARY_SQL} WHERE b.id = ?`).bind(ts, ts, id).first<any>();
  return r ? toSummary(r, ts) : null;
}

/**
 * Refuse to link an offer to a budget that does not exist or is of the wrong
 * kind. A closed budget may stay linked (the offer simply stops), but a new
 * link must point at a budget that can still be used.
 */
export async function assertLinkableBudget(env: Env, id: string, kind: BudgetKind): Promise<BudgetSummary> {
  const b = await getBudget(env, id);
  if (!b) throw httpsError("not-found", "Promo budget not found.");
  if (b.kind !== kind) {
    const need: Record<BudgetKind, string> = {
      package_bonus: "Coin package ke liye 'Package bonus' budget chuno.",
      contest_prize: "Coin prize wale contest ke liye 'Contest prize' budget chuno.",
      product_prize: "Product prize wale contest ke liye 'Product prize' budget chuno.",
      free_rewards: "Free rewards ki limit ke liye 'Free rewards' budget chuno.",
    };
    throw httpsError("invalid-argument", `Galat budget type. ${need[kind]}`);
  }
  if (b.status === "closed") throw httpsError("failed-precondition", "Ye budget closed hai. Naya budget banao.");
  return b;
}

/**
 * Which budgets can fund one more unit right now (for the public catalog and
 * contest listing): live and with at least `coins` of room.
 */
export async function budgetsWithRoom(env: Env, ids: string[], ts = Date.now()): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return out;
  const placeholders = unique.map(() => "?").join(",");
  const res = await env.DB.prepare(
    `SELECT b.id AS id, b.total_coins - b.spent_coins - ${HELD_SUM} AS room
       FROM promo_budgets b
      WHERE b.id IN (${placeholders}) AND b.status = 'active'
        AND (b.starts_at IS NULL OR b.starts_at <= ?)
        AND (b.ends_at IS NULL OR b.ends_at > ?)`,
  ).bind(ts, ...unique, ts, ts).all<{ id: string; room: number }>();
  for (const r of res.results ?? []) out.set(r.id, Math.max(0, Number(r.room) || 0));
  return out;
}
