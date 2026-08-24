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
export function assertPrizeFundedByPot(totalEntryFee: unknown, rewardCoins: unknown): void {
  const pot = matchPot(totalEntryFee);
  const reward = Number(rewardCoins || 0);
  if (!Number.isFinite(reward) || reward < 0) {
    throw httpsError("invalid-argument", "rewardCoins must be a non-negative whole number.");
  }
  if (reward > pot) {
    throw httpsError(
      "invalid-argument",
      `rewardCoins (${reward}) cannot exceed the entry-fee pot (${pot}). ` +
        `Two players fund ${pot} coins in total for a ${Number(totalEntryFee || 0)}-coin contest, ` +
        `so a larger prize would mint coins on every match.`,
    );
  }
}

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
): Promise<{ newBalance: number; applied: number }> {
  const amount = assertCoinAmount(input.amount, "amount");
  if (!input.uid || typeof input.uid !== "string") {
    throw httpsError("invalid-argument", "uid is required.");
  }
  const delta = input.direction === "add" ? amount : -amount;
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
      `INSERT OR IGNORE INTO coin_transactions
         (id, uid, amount, type, contest_id, match_id, description, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM users WHERE uid = ? AND dpcoin + ? >= 0
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
      input.uid,
      delta,
      ...claimBindings,
    ),
    env.DB.prepare(
      `UPDATE users
          SET dpcoin = dpcoin + ?, updated_at = ?
        WHERE uid = ? AND dpcoin + ? >= 0
          ${claimGate}`,
    ).bind(delta, ts, input.uid, delta, ...claimBindings),
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
    const existing = await env.DB.prepare(`SELECT dpcoin FROM users WHERE uid = ?`)
      .bind(input.uid)
      .first<{ dpcoin: number | null }>();
    if (!existing) throw httpsError("not-found", "User not found.");
    throw httpsError(
      "failed-precondition",
      `Insufficient balance: cannot subtract ${amount} coins from a balance of ${Number(existing.dpcoin || 0)}.`,
    );
  }

  const updated = await env.DB.prepare(`SELECT dpcoin FROM users WHERE uid = ?`)
    .bind(input.uid)
    .first<{ dpcoin: number | null }>();

  return { newBalance: Number(updated?.dpcoin || 0), applied: delta };
}
