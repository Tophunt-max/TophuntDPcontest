import { httpsError } from "./http";
import type { Env } from "../types";

/**
 * Money invariants for the coin economy.
 *
 * Coins are a WHOLE-NUMBER currency. `users.dpcoin` and every amount column is
 * declared `REAL` in D1 for historical reasons, but SQLite is dynamically typed
 * so integers stored in a REAL column stay exact. The rule this module enforces
 * is therefore: **never write a non-integer coin amount**. Once a fraction gets
 * in, repeated `+=`/`-=` accumulate IEEE-754 drift and the ledger can never be
 * reconciled against the balance again.
 *
 * Fiat (INR) is different: it legitimately has paise. Fiat is either stored in
 * integer paise (`payment_orders.amount_paise`, `payments.amount_paise`) or
 * rounded to 2 decimals via `roundFiat` before it is written.
 */

/** Upper bound for any single coin movement. Rejects absurd/typo'd amounts. */
export const MAX_COIN_AMOUNT = 10_000_000;

/**
 * Assert a value is a usable whole-coin amount and return it as a number.
 * Rejects NaN, Infinity, fractions, negatives, zero and out-of-range values —
 * the direction of a movement is always expressed separately, never by sign.
 */
export function assertCoinAmount(value: unknown, field = "amount"): number {
  const amount = typeof value === "number" ? value : Number(value);
  if (
    typeof value === "boolean" ||
    value === null ||
    value === undefined ||
    (typeof value === "string" && !value.trim()) ||
    !Number.isFinite(amount) ||
    !Number.isInteger(amount) ||
    amount <= 0 ||
    amount > MAX_COIN_AMOUNT
  ) {
    throw httpsError(
      "invalid-argument",
      `${field} must be a whole number of coins between 1 and ${MAX_COIN_AMOUNT}.`,
    );
  }
  return amount;
}

/** Same as `assertCoinAmount` but allows 0 (for configured amounts like rewards). */
export function assertCoinAmountOrZero(value: unknown, field = "amount"): number {
  const amount = typeof value === "number" ? value : Number(value);
  if (amount === 0) return 0;
  return assertCoinAmount(value, field);
}

/** Round a fiat value to 2 decimals so INR never carries float dust. */
export function roundFiat(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100) / 100;
}

/** Convert a rupee value to integer paise. */
export function toPaise(rupees: number): number {
  if (!Number.isFinite(rupees)) return 0;
  return Math.round(rupees * 100);
}

/**
 * A match is funded by two players paying half of `totalEntryFee` each.
 *
 * `Math.floor` keeps the charge a whole number even for legacy contests created
 * before `totalEntryFee` was required to be even. Charge and refund both go
 * through this function, so they are always symmetric.
 */
export function perPlayerEntryFee(totalEntryFee: unknown): number {
  const total = Number(totalEntryFee || 0);
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.floor(total / 2);
}

/** Coins actually collected for a match — the pot a prize may be paid from. */
export function matchPot(totalEntryFee: unknown): number {
  return perPlayerEntryFee(totalEntryFee) * 2;
}

/**
 * The core money invariant: a prize may never exceed the pot the two players
 * funded. Without this, `rewardCoins` is an unbounded coin printer — every
 * settled match would mint `rewardCoins - totalEntryFee` coins out of nothing.
 *
 * Promotional prizes larger than the pot need an explicitly funded pool and a
 * ledger entry for the subsidy; they are deliberately not silently allowed.
 */
export function assertPrizeFundedByPot(
  totalEntryFee: unknown,
  rewardCoins: unknown,
  opts: { subsidyBudgetId?: string | null } = {},
): void {
  const pot = matchPot(totalEntryFee);
  const reward = Number(rewardCoins || 0);
  if (!Number.isFinite(reward) || reward < 0) {
    throw httpsError("invalid-argument", "rewardCoins must be a non-negative whole number.");
  }
  // The funded pool: a promo budget (lib/promoBudget.ts) pays the difference
  // per match, reserved when the match is created and ledgered at settlement.
  if (reward > pot && opts.subsidyBudgetId) return;
  if (reward > pot) {
    throw httpsError(
      "invalid-argument",
      `rewardCoins (${reward}) cannot exceed the entry-fee pot (${pot}). ` +
        `Two players fund ${pot} coins in total for a ${Number(totalEntryFee || 0)}-coin contest, ` +
        `so a larger prize would mint coins on every match. ` +
        `Zyada prize dena hai to contest ko ek "contest_prize" promo budget se jodo (Coin Economy → Budgets).`,
    );
  }
}

/**
 * A product prize's admin-set coin cost above the pot must be paid by a
 * product_prize promo budget, reserved per match like a coin subsidy. A cost
 * at or below the pot (or no cost at all) needs no budget.
 */
export function assertProductCostFunded(totalEntryFee: unknown, prizeCostCoins: unknown, budgetId?: string | null): void {
  const cost = Number(prizeCostCoins || 0);
  const pot = matchPot(totalEntryFee);
  if (cost > pot && !budgetId) {
    throw httpsError(
      "invalid-argument",
      `Product ki cost (${cost} coins) pot (${pot}) se zyada hai. Contest ko ek "Product prize" budget se jodo ` +
        `(har jeet par ${cost - pot} coin budget se katenge).`,
    );
  }
}

/**
 * The most a match may ever pay: the pot the two players funded, plus the
 * subsidy reserved for it from a promo budget when it was created. Every
 * settlement path clamps to this, so nothing can pay more than was funded.
 */
export function matchPrizeCeiling(totalEntryFee: unknown, subsidyCoins: unknown): number {
  const subsidy = Number(subsidyCoins || 0);
  return matchPot(totalEntryFee) + (Number.isFinite(subsidy) && subsidy > 0 ? Math.floor(subsidy) : 0);
}

/**
 * SQL for `users.locked_coins` after a debit of `?` coins that is NOT an entry
 * fee (a clawback, an admin subtraction, a legacy payout): locked coins can
 * never exceed what is left of the balance. Bind the debit amount once.
 */
export const LOCKED_AFTER_DEBIT = "MIN(locked_coins, MAX(0, dpcoin - ?))";

/**
 * SQL for `users.locked_coins` after reversing a coin PURCHASE of `?` coins.
 * Purchases are credited as Diamonds (lib/diamonds.ts), so the reversal takes
 * Diamonds first and only the rest from DP coins; Diamonds still never exceed
 * what is left of the balance. Bind the debit amount TWICE.
 */
export const DIAMONDS_AFTER_DEBIT = "MIN(MAX(0, locked_coins - ?), MAX(0, dpcoin - ?))";

export interface WalletAdjustment {
  uid: string;
  /** Always a positive whole number — direction is set by `direction`. */
  amount: number;
  direction: "add" | "subtract";
  /** `coin_transactions.type` */
  type: string;
  description: string;
  /** Ledger row id. Defaults to a random uuid. */
  ledgerId?: string;
  /**
   * Replay protection. When set, the whole adjustment is claimed in
   * `idempotency_keys` inside the same transaction, so retrying with the same
   * key moves nothing — neither balance nor ledger.
   */
  claimKey?: string;
  /**
   * Diamonds (users.locked_coins, lib/diamonds.ts) instead of DP coins.
   * "add": credit Diamonds (play-only, never withdrawable).
   * "subtract": take Diamonds only, and fail if the user has fewer.
   * Without it a subtraction takes DP coins first, as before.
   */
  locked?: boolean;
  contestId?: string | null;
  matchId?: string | null;
  ts?: number;
}

export class WalletReplay extends Error {
  constructor(readonly claimKey: string) {
    super(`Adjustment ${claimKey} was already applied.`);
  }
}

/**
 * Drop a wallet claim that won its insert but whose adjustment did not apply.
 *
 * Deletes on `(key, nonce)`, never on the key alone: the nonce proves the row is
 * OURS. Without that, a release racing a concurrent retry could delete the row the
 * other request is relying on and let both adjustments through — the exact
 * double-spend the claim exists to stop.
 *
 * Best-effort by design. If the delete fails the worst outcome is the pre-existing
 * behaviour (the key stays consumed), so it must not mask the real error being
 * raised by the caller.
 */
async function releaseWalletClaim(
  env: Env,
  claimKey: string | undefined,
  nonce: string,
): Promise<void> {
  if (!claimKey) return;
  try {
    await env.DB.prepare(`DELETE FROM idempotency_keys WHERE key = ? AND nonce = ?`)
      .bind(claimKey, nonce)
      .run();
  } catch (e) {
    console.error("[money] could not release wallet claim", claimKey, e);
  }
}

/**
 * The single supported way to move an account balance from an admin path.
 *
 * Guarantees, all of which the previous two divergent implementations broke in
 * one way or another:
 *
 * 1. The amount is a positive whole number (no negatives smuggled through a
 *    direction of "add", no fractions, no NaN/Infinity).
 * 2. The balance update and its ledger row are ONE D1 transaction, so a balance
 *    can never move without a matching ledger entry.
 * 3. A subtract that exceeds the balance FAILS LOUDLY rather than silently
 *    clamping to zero — clamping is what desynchronised the ledger from the
 *    balance, because the ledger recorded the requested delta while the balance
 *    only moved by what was available.
 * 4. The ledger insert is guarded on the same pre-transaction balance snapshot
 *    as the update, so the two statements can never disagree.
 * 5. `ledgerId` is a PK, so replaying the same logical adjustment is a no-op.
 */
export async function adjustUserWallet(
  env: Env,
  input: WalletAdjustment,
): Promise<{ newBalance: number; applied: number; newDiamonds: number }> {
  const amount = assertCoinAmount(input.amount, "amount");
  if (!input.uid || typeof input.uid !== "string") {
    throw httpsError("invalid-argument", "uid is required.");
  }
  const delta = input.direction === "add" ? amount : -amount;
  // Added locked coins (a play-only reward), bound into both statements below.
  const lockedAdd = input.direction === "add" && input.locked ? amount : 0;
  // A Diamond subtraction: gated on the Diamonds, and moves only them.
  const fromDiamonds = input.direction === "subtract" && input.locked === true;
  const gateSql = fromDiamonds ? "MIN(locked_coins, dpcoin) >= ?" : "dpcoin + ? >= 0";
  const gateArg = fromDiamonds ? amount : delta;
  const lockedDeltaSql = fromDiamonds
    ? "(SELECT -? FROM users WHERE uid = ?)"
    : "(SELECT CASE WHEN ? < 0 THEN MIN(locked_coins, MAX(0, dpcoin + ?)) - locked_coins ELSE ? END FROM users WHERE uid = ?)";
  const lockedSetSql = fromDiamonds
    ? "locked_coins - ?"
    : "CASE WHEN ? < 0 THEN MIN(locked_coins, MAX(0, dpcoin + ?)) ELSE locked_coins + ? END";
  const lockedArgs = fromDiamonds ? [amount] : [delta, delta, lockedAdd];
  const ts = input.ts ?? Date.now();
  const ledgerId = input.ledgerId ?? crypto.randomUUID();

  // A per-request random nonce is what makes the claim exact. On a replay the
  // `INSERT OR IGNORE` keeps the ORIGINAL row (with its original nonce), so
  // every `nonce = ?` gate below fails and the whole adjustment no-ops. Using a
  // timestamp instead of a nonce would let two requests in the same millisecond
  // both pass.
  const nonce = crypto.randomUUID();
  const claimGate = input.claimKey
    ? `AND EXISTS (SELECT 1 FROM idempotency_keys WHERE key = ? AND nonce = ?)`
    : "";
  const claimBindings = input.claimKey ? [input.claimKey, nonce] : [];

  const statements: D1PreparedStatement[] = [];
  if (input.claimKey) {
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO idempotency_keys (key, nonce, scope, created_at)
         VALUES (?, ?, ?, ?)`,
      ).bind(input.claimKey, nonce, "wallet", ts),
    );
  }

  // The ledger INSERT and the balance UPDATE test `dpcoin + delta >= 0` against
  // the SAME pre-transaction snapshot: the INSERT runs first and does not touch
  // `users`, so the UPDATE that follows evaluates an identical condition. They
  // can therefore only both apply or both no-op — a balance can never move
  // without its ledger row, and vice versa.
  statements.push(
    env.DB.prepare(
      // `locked_delta`: a subtraction can take the balance below the locked
      // (play-only) coins, which are then reduced with it so they never exceed
      // the balance. Read from the same pre-update snapshot as the UPDATE below.
      `INSERT OR IGNORE INTO coin_transactions
         (id, uid, amount, type, contest_id, match_id, description, created_at, locked_delta)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?,
              ${lockedDeltaSql}
        WHERE EXISTS (
          SELECT 1 FROM users WHERE uid = ? AND ${gateSql}
        )
        ${claimGate}`,
    ).bind(
      ledgerId,
      input.uid,
      delta,
      input.type,
      input.contestId ?? null,
      input.matchId ?? null,
      input.description,
      ts,
      ...lockedArgs,
      input.uid,
      input.uid,
      gateArg,
      ...claimBindings,
    ),
    env.DB.prepare(
      `UPDATE users
          SET dpcoin = dpcoin + ?,
              locked_coins = ${lockedSetSql},
              updated_at = ?
        WHERE uid = ? AND ${gateSql}
          ${claimGate}`,
    ).bind(delta, ...lockedArgs, ts, input.uid, gateArg, ...claimBindings),
  );

  const results = await env.DB.batch(statements);
  const updateResult = results[results.length - 1];

  if (Number(updateResult?.meta?.changes || 0) === 0) {
    // Nothing moved. Three possible reasons, each needs a distinct answer.
    if (input.claimKey) {
      const claimed = await env.DB.prepare(
        `SELECT nonce FROM idempotency_keys WHERE key = ?`,
      )
        .bind(input.claimKey)
        .first<{ nonce: string }>();
      // Our nonce did not win the claim => this exact adjustment already ran.
      if (claimed && claimed.nonce !== nonce) throw new WalletReplay(input.claimKey);
    }
    const existing = await env.DB.prepare(`SELECT dpcoin, locked_coins FROM users WHERE uid = ?`)
      .bind(input.uid)
      .first<{ dpcoin: number | null; locked_coins: number | null }>();
    // The batch COMMITTED — the claim row is in the database even though no money
    // moved, because the claim insert is unconditional while the money statements
    // are gated. Leaving it there permanently poisons the key: a legitimate retry
    // with the same `Idempotency-Key` would find the stale row, lose the nonce
    // comparison above, and be reported to the caller as
    // "already updated (no change applied)" — telling an admin an adjustment had
    // happened when it never did, and making it impossible with that key.
    //
    // Releasing it is safe precisely because nothing else in the batch applied:
    // `changes === 0` on the gated UPDATE proves the balance did not move, and the
    // ledger insert shares that gate, so there is no committed effect to protect.
    await releaseWalletClaim(env, input.claimKey, nonce);
    if (!existing) throw httpsError("not-found", "User not found.");
    if (fromDiamonds) {
      throw httpsError(
        "failed-precondition",
        `Insufficient Diamonds: cannot subtract ${amount} from ${Math.min(Number(existing.locked_coins || 0), Number(existing.dpcoin || 0))} Diamonds.`,
      );
    }
    throw httpsError(
      "failed-precondition",
      `Insufficient balance: cannot subtract ${amount} coins from a total (DP coin + Diamond) of ${Number(existing.dpcoin || 0)}.`,
    );
  }

  const updated = await env.DB.prepare(`SELECT dpcoin, locked_coins FROM users WHERE uid = ?`)
    .bind(input.uid)
    .first<{ dpcoin: number | null; locked_coins: number | null }>();

  // newBalance is the TOTAL (DP coin + Diamond); newDiamonds its Diamond part.
  return { newBalance: Number(updated?.dpcoin || 0), applied: delta, newDiamonds: Number(updated?.locked_coins || 0) };
}


export interface CoinPackageInput {
  name: string | null;
  coins: number;
  bonusCoins: number;
  priceInr: number;
  active: boolean;
  sortOrder: number;
}

/**
 * Validate a coin package before it is written.
 *
 * `coin_packages` is the ONLY pricing authority for both Razorpay checkout and
 * manual deposits, yet writes accepted anything: a 0-rupee package, a negative
 * price, or a fractional coin count would all have been stored and then used to
 * price real purchases. Reads validated the row defensively; writes did not
 * validate at all, which is the wrong end to catch it.
 */
export function validateCoinPackage(
  body: Record<string, any>,
  existing?: Partial<CoinPackageInput>,
  opts: { promoFunded?: boolean } = {},
): Partial<CoinPackageInput> {
  const out: Partial<CoinPackageInput> = {};
  const has = (key: string) => Object.prototype.hasOwnProperty.call(body, key) && body[key] !== undefined;

  if (has("name")) {
    const name = body.name === null ? null : String(body.name).trim();
    if (name !== null && (name.length === 0 || name.length > 120)) {
      throw httpsError("invalid-argument", "Package name must be 1–120 characters.");
    }
    out.name = name;
  }

  if (has("coins")) out.coins = assertCoinAmount(body.coins, "coins");
  if (has("bonusCoins")) out.bonusCoins = assertCoinAmountOrZero(body.bonusCoins, "bonusCoins");

  if (has("priceInr")) {
    const price = Number(body.priceInr);
    if (!Number.isFinite(price) || price <= 0 || price > 1_000_000) {
      throw httpsError("invalid-argument", "priceInr must be a positive amount up to 1,000,000.");
    }
    // Razorpay charges in integer paise, so a price with sub-paise precision
    // could never be charged exactly.
    if (Math.round(price * 100) !== Number((price * 100).toFixed(4))) {
      throw httpsError("invalid-argument", "priceInr cannot have more than 2 decimal places.");
    }
    out.priceInr = roundFiat(price);
  }

  if (has("active")) out.active = !!body.active;

  if (has("sortOrder")) {
    const order = Number(body.sortOrder);
    if (!Number.isInteger(order) || order < 0 || order > 10_000) {
      throw httpsError("invalid-argument", "sortOrder must be a whole number between 0 and 10,000.");
    }
    out.sortOrder = order;
  }

  // A bonus larger than the paid amount is almost always a typo (a misplaced
  // zero), and it silently doubles the coins sold for a fixed price.
  const coins = out.coins ?? existing?.coins;
  const bonus = out.bonusCoins ?? existing?.bonusCoins;
  // A budget-funded bonus is a deliberate promotion capped by its budget, and it
  // is credited as locked (play-only) coins, so "bigger than the paid coins" is
  // allowed there.
  if (coins != null && bonus != null && bonus > coins && !opts.promoFunded) {
    throw httpsError(
      "invalid-argument",
      `bonusCoins (${bonus}) cannot exceed the paid coins (${coins}).`,
    );
  }

  return out;
}
